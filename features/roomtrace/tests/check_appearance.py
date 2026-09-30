"""Local projection preserves triangle coordinates and never paints occluded faces."""

import sys
import tempfile
import hashlib
import asyncio
import httpx
import cv2
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_refinement import fixture
from app.architecture import build_mesh
from app.architecture.appearance import bake_appearance, projection_rejection
from app.architecture.alignment import fit_photos, world_points, camera_model
from app.photo_materials import PhotoMaterial, material_image
from app import store, config
from app.main import app
from app.architecture import Placement, move_object
from app.architecture.refinement import scale_document


def triangles(scene):
    mesh = scene.to_mesh()
    rows = np.sort(mesh.triangles, axis=1).reshape(-1, 9).round(7)
    return rows[np.lexsort(rows.T[::-1])]


doc, frames = fixture()
doc.elements[1].position = (1.0, 0.5, 1.0)
for i, alignment in enumerate(doc.alignments):
    k, distortion = camera_model(alignment, frames[i]["size"])
    pixels = cv2.projectPoints(
        world_points(doc, alignment.matches),
        np.zeros(3),
        np.array([i * 0.2, -0.5, 7.0]),
        k,
        distortion,
    )[0].reshape(-1, 2)
    for match, pixel in zip(alignment.matches, pixels):
        match.image = tuple(pixel / frames[i]["size"])
original = build_mesh(doc)
with tempfile.TemporaryDirectory() as name:
    root = Path(name)
    for frame in frames:
        Image.new("RGB", tuple(frame["size"]), (180, 100, 70)).save(
            root / frame["name"]
        )
    report = bake_appearance(doc, frames, root, root / "output")
    result = trimesh.load(root / "output/photo-appearance.glb", force="scene")
    assert np.allclose(triangles(original), triangles(result), atol=1e-6)
    for key, mesh in result.geometry.items():
        if key.endswith("__photo_-1"):
            source = original.geometry[key.removesuffix("__photo_-1")]
            assert np.array_equal(
                mesh.visual.material.baseColorFactor,
                source.visual.material.baseColorFactor,
            ), key
    assert 0 < report["photo_covered_area_fraction"] < 1, report
    assert report["original_material_faces"] > 0
    assert (
        sum(v["textured_faces"] for v in report["source_images"])
        + report["original_material_faces"]
        == report["surface_triangles"]
    )
    assert report["unaligned_sources"] == ["00002.jpg", "00003.jpg"]
    assert report["promoted"] is False
    bad = doc.model_copy(deep=True)
    for alignment in bad.alignments:
        alignment.matches[-1].image = (0.9, 0.9)
    blocked = bake_appearance(bad, frames, root, root / "blocked")
    assert blocked["photo_covered_area_fraction"] == 0
    assert all(s["projection_rejection"] for s in blocked["source_images"])
    unsupported = fit_photos(doc, frames)[0] | {"check_count": 0}
    assert projection_rejection(unsupported, 4)
print(
    "PASS: local projection, unchanged triangles/materials, poor/missing checks rejected"
)


def photo_material_contract():
    original_data = store.DATA
    with tempfile.TemporaryDirectory() as tmp:
        store.DATA = Path(tmp)
        try:
            job = store.create_job("Material math check", {"engine": "architecture"})
            directory = store.job_dir(job["id"])
            (directory / "images").mkdir()
            # Known pixel pattern with a contrasting background outside the clean selected region.
            pixels = np.zeros((160, 200, 3), dtype=np.uint8)
            pixels[:] = [255, 0, 0]
            y, x = np.mgrid[:100, :120]
            pixels[30:130, 40:160] = np.stack(
                [40 + x, 50 + y, np.full_like(x, 80)], axis=-1
            )
            path = directory / "images/00000.jpg"
            Image.fromarray(pixels).save(path, quality=100, subsampling=0)
            for i in range(1, 4):
                (directory / "images" / f"{i:05}.jpg").write_bytes(path.read_bytes())
            store.atomic_json(
                directory / "frames.json",
                [{"name": f"{i:05}.jpg", "size": [200, 160]} for i in range(4)],
            )
            spec = PhotoMaterial(
                name="Observed clean material",
                map_id=job["id"],
                source=path.name,
                sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                quad=[[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]],
                repeat_m=[0.5, 0.4],
                targets=["fixed"],
                note="Numerical image test, no home claim.",
            )
            patch = np.asarray(material_image(spec))
            assert (patch[:, :, 0] < 200).all()  # No unrelated red surround.
            assert np.array_equal(patch[0], patch[-1]) and np.array_equal(
                patch[:, 0], patch[:, -1]
            )
            model, _ = fixture()
            model.photo_materials = [spec]
            textured = build_mesh(model)
            baseline = build_mesh(model.model_copy(update={"photo_materials": []}))
            assert np.allclose(triangles(textured), triangles(baseline))
            assert textured.geometry["moving"].visual.material.baseColorTexture is None
            assert np.array_equal(
                textured.geometry["fixed"].visual.material.baseColorFactor, [255] * 4
            )
            moved = move_object(
                model,
                Placement(
                    element_id="fixed",
                    translation=[2, 0, 1],
                    yaw=0.7,
                    expected_revision=1,
                ),
            )
            assert np.allclose(
                build_mesh(moved).geometry["fixed"].visual.uv,
                textured.geometry["fixed"].visual.uv,
            )
            scaled = scale_document(model, 2)
            assert np.allclose(
                build_mesh(scaled).geometry["fixed"].visual.uv,
                textured.geometry["fixed"].visual.uv,
            )
            out = directory / "textured.glb"
            textured.export(out)
            restored = trimesh.load(out, force="scene")
            assert np.array_equal(
                np.asarray(restored.geometry["fixed"].visual.material.baseColorTexture),
                patch,
            )

            async def routes():
                store.update_job(job["id"], status="awaiting_agent")
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app),
                    base_url="http://localhost",
                    headers={"authorization": "Bearer " + config.ACCESS_TOKEN},
                    timeout=None,
                ) as client:
                    url = f"/api/maps/{job['id']}/architecture"
                    response = await client.post(
                        url,
                        json={"expected_revision": 0, "document": model.model_dump()},
                    )
                    assert response.status_code == 200, response.text
                    contract = await client.get(url + "/materials")
                    assert (
                        contract.status_code == 200
                        and len(contract.json()["targets"]) == 2
                    )
                    preview = await client.post(
                        url + "/materials/preview", json=spec.model_dump()
                    )
                    assert preview.status_code == 200 and preview.content.startswith(
                        b"\x89PNG"
                    )
                    rejected = await client.post(
                        url + "/materials/preview",
                        json=spec.model_dump() | {"sha256": "0" * 64},
                    )
                    assert rejected.status_code == 422
                    stale = await client.post(
                        url,
                        json={"expected_revision": 0, "document": model.model_dump()},
                    )
                    assert stale.status_code == 409
                    assert store.get_job(job["id"])["revision"] == 1
                    source = path.read_bytes()
                    path.write_bytes(source + b"updated source bytes")
                    repair = await client.get(url + "/materials")
                    rejected = await client.post(
                        url + "/materials/preview", json=spec.model_dump()
                    )
                    path.write_bytes(source)
                    assert repair.status_code == 200
                    assert repair.json()["sources"][0]["sha256"] != spec.sha256
                    assert rejected.status_code == 422

            asyncio.run(routes())
            for update in [
                {"sha256": "0" * 64},
                {"source": "../.env"},
                {"targets": ["missing"]},
                {"quad": [[0, 0], [1, 1], [1, 0], [0, 1]]},
            ]:
                try:
                    modified = PhotoMaterial.model_validate(spec.model_dump() | update)
                    build_mesh(model.model_copy(update={"photo_materials": [modified]}))
                except ValueError:
                    continue
                raise AssertionError(f"Accepted invalid material {update}")
            path.write_bytes(b"changed source")
            try:
                material_image(spec)
            except ValueError:
                pass
            else:
                raise AssertionError("Cache concealed changed source bytes")
        finally:
            store.DATA = original_data
    print(
        "PASS: photo patches, reflection borders, exact targets, GLB roundtrip, local UV movement/scale, real HTTP publication/preview, invalid evidence, conflicts and stale-cache rejection"
    )


photo_material_contract()

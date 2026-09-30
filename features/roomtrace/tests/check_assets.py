"""Run after code completion: isolated asset/API contracts, not home reconstruction evidence."""

import asyncio
import copy
import io
import json
import math
import struct
import sys
import tempfile
from pathlib import Path

import httpx
import numpy as np
import trimesh
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import assets, config, store
from app.architecture import (
    Architecture,
    Placement,
    anchor_matrix,
    build_mesh,
    component_meshes,
    move_object,
)
from app.architecture.checks import inspect_geometry
from app.main import app


def rewritten_glb(data, edit):
    size = struct.unpack_from("<I", data, 12)[0]
    tree = json.loads(data[20 : 20 + size])
    edit(tree)
    header = json.dumps(tree).encode()
    header += b" " * (-len(header) % 4)
    tail = data[20 + size :]
    return (
        struct.pack(
            "<4sIIII", b"glTF", 2, 20 + len(header) + len(tail), len(header), 0x4E4F534A
        )
        + header
        + tail
    )


def textured_glb():
    # Two material-separated arbitrary tetrahedra with a nonidentity scene transform.
    vertices = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [0, 0, 1]]
    faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]
    scene = trimesh.Scene()
    for i in range(2):
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        mesh.visual = trimesh.visual.TextureVisuals(
            uv=[[0, 0], [1, 0], [0, 1], [1, 1]],
            material=trimesh.visual.material.PBRMaterial(
                name=f"material_{i}",
                baseColorFactor=[1.0, 1.0, 1.0, 1.0],
                baseColorTexture=Image.new("RGB", (8, 8), (120 + i * 30, 80, 40)),
                normalTexture=Image.new("RGB", (8, 8), (128, 128, 255)),
                metallicRoughnessTexture=Image.new("RGB", (8, 8), (0, 160, 20)),
                roughnessFactor=0.6,
                metallicFactor=0.2,
            ),
        )
        transform = trimesh.transformations.translation_matrix([7 + i * 4, 9, -5])
        scene.add_geometry(
            mesh, geom_name=f"piece_{i}", node_name=f"piece_{i}", transform=transform
        )
    return scene.export(file_type="glb")


async def main():
    original = (config.DATA, store.DATA, config.ACCESS_TOKEN)
    with tempfile.TemporaryDirectory() as temporary:
        config.DATA = store.DATA = Path(temporary)
        config.ACCESS_TOKEN = "asset-test-token"
        try:
            job = store.create_job("Geometry fixture only", {"engine": "architecture"})
            store.update_job(job["id"], status="awaiting_agent")
            directory = store.job_dir(job["id"])
            (directory / "images").mkdir()
            frames = []
            for index in range(4):
                name = f"{index:05d}.jpg"
                Image.new("RGB", (128, 96), (40, 50 + index, 60)).save(
                    directory / "images" / name
                )
                frames.append({"name": name, "original": name, "size": [128, 96]})
            store.atomic_json(directory / "frames.json", frames)
            spec = dict(
                name="Uncatalogued asymmetrical object",
                description="Arbitrary topology fixture, not a furniture type.",
                provenance="Unit geometry only",
                metres_per_unit=0.1,
                up_axis="z",
                dimension_basis="estimated",
                dimension_note="Synthetic known conversion for testing.",
                sources=[
                    dict(
                        map_id=job["id"],
                        source="00000.jpg",
                        box=[0.1, 0.2, 0.9, 0.8],
                        note="Test region",
                    )
                ],
                authoring_source="Inert source text; must never be executed.",
            )
            raw = textured_glb()
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://localhost", timeout=None
            ) as client:
                assert (await client.get("/api/assets")).status_code == 401
                assert (
                    await client.post(
                        "/api/session", json={"token": config.ACCESS_TOKEN}
                    )
                ).status_code == 200
                assert (await client.get("/api/assets/schema")).status_code == 200

                async def upload(data=raw, metadata=spec):
                    return await client.post(
                        "/api/assets",
                        files={"file": ("object.glb", data)},
                        data={"metadata": json.dumps(metadata)},
                    )

                first = await upload()
                assert first.status_code == 201, first.text
                record = first.json()
                identifier = record["id"]
                assert (await upload()).json()["id"] == identifier
                assert record["parts"] == 2 and record["triangles"] == 8
                assert record["sources"][0]["image_sha256"] == assets.digest(
                    (directory / "images/00000.jpg").read_bytes()
                )
                assert np.allclose(record["dimensions"], [0.6, 0.1, 0.3])
                assert np.allclose(record["bounds"][0], [-0.3, 0, -0.15])
                source = await client.get(
                    f"/api/assets/{identifier}/model?original=true"
                )
                assert source.content == raw
                assert source.headers["cache-control"].startswith("private")
                loaded = assets.asset_parts(identifier)
                assert len(loaded) == 2
                assert all(
                    part.visual.material.baseColorTexture is not None
                    and part.visual.material.normalTexture is not None
                    and part.visual.material.metallicRoughnessTexture is not None
                    for part in loaded
                )
                original_bounds = np.array(record["bounds"])
                loaded[0].apply_translation([100, 100, 100])
                assert np.allclose(
                    trimesh.util.concatenate(assets.asset_parts(identifier)).bounds,
                    original_bounds,
                )
                assert (
                    await client.get(
                        "/api/assets", params={"query": "uncatalogued", "limit": 1}
                    )
                ).json()["total"] == 1
                assert not (
                    await client.get("/api/assets", params={"query": "nonexistent"})
                ).json()["items"]
                assert not (
                    await client.get("/api/assets", params={"offset": 1})
                ).json()["items"]
                assert (
                    await client.get("/api/assets", params={"offset": -1})
                ).status_code == 422
                assert (
                    await client.get("/api/assets", params={"limit": 51})
                ).status_code == 422
                changed = dict(
                    spec, name="Separate evidence", previous_asset=identifier
                )
                second = (await upload(metadata=changed)).json()
                assert (
                    second["id"] != identifier
                    and second["source_sha256"] == record["source_sha256"]
                )
                assert second["model_sha256"] == record["model_sha256"]
                crop = await client.post(
                    "/api/asset-reference", json=spec["sources"][0]
                )
                assert crop.status_code == 200
                assert Image.open(io.BytesIO(crop.content)).size == (104, 58)
                assert (
                    await client.post(
                        "/api/asset-reference",
                        json=dict(spec["sources"][0], source="../outside.jpg"),
                    )
                ).status_code == 422
                assert (await upload(b"not glb")).status_code == 422
                assert (
                    await upload(
                        rewritten_glb(
                            raw,
                            lambda tree: tree["buffers"][0].update(
                                uri="https://example.invalid/forbidden"
                            ),
                        )
                    )
                ).status_code == 422
                assert (
                    await upload(
                        rewritten_glb(raw, lambda tree: tree.update(animations=[{}]))
                    )
                ).status_code == 422
                assert (
                    await upload(
                        rewritten_glb(
                            raw,
                            lambda tree: tree.update(
                                extensionsRequired=["KHR_draco_mesh_compression"]
                            ),
                        )
                    )
                ).status_code == 422
                assert (
                    await upload(
                        rewritten_glb(
                            raw, lambda tree: tree["nodes"][0].update(children=[0])
                        )
                    )
                ).status_code == 422
                assert (
                    await upload(
                        metadata=dict(
                            spec,
                            sources=[dict(spec["sources"][0], source="foreign.jpg")],
                        )
                    )
                ).status_code == 422
                model_body = {
                    "spec": dict(
                        spec,
                        name="New indexed topology",
                        up_axis="y",
                        metres_per_unit=1,
                    ),
                    "parts": [
                        {
                            "name": "unspecified form",
                            "vertices": [[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3]],
                            "faces": [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
                            "color": "#887766",
                        }
                    ],
                }
                authored = await client.post("/api/assets/mesh", json=model_body)
                assert authored.status_code == 201, authored.text
                broken = copy.deepcopy(model_body)
                broken["parts"][0]["faces"][0][0] = 9
                assert (
                    await client.post("/api/assets/mesh", json=broken)
                ).status_code == 422
                common = dict(
                    level="floor",
                    sources=["00000.jpg"],
                    evidence="Fixture only",
                    color="#887766",
                )
                model = Architecture.model_validate(
                    dict(
                        title="Open asset",
                        notes=["No home acceptance claim"],
                        levels=[dict(id="floor", name="Floor", elevation=2)],
                        elements=[
                            dict(
                                common,
                                id="slab",
                                label="Support",
                                kind="slab",
                                polygon=[[-3, -3], [3, -3], [3, 3], [-3, 3]],
                                thickness=0.2,
                            ),
                            dict(
                                common,
                                id="thing",
                                label="A new shape without category",
                                kind="asset",
                                asset_id=identifier,
                                position=[1, 0, 1],
                                scale=2,
                                observations=[
                                    dict(
                                        source="00000.jpg",
                                        box=[0.1, 0.2, 0.9, 0.8],
                                        note="Instance evidence",
                                    )
                                ],
                            ),
                        ],
                    )
                )
                components = component_meshes(model)
                assert np.allclose(
                    components["thing"].bounds, [[0.4, 2, 0.7], [1.6, 2.2, 1.3]]
                )
                anchor = anchor_matrix(
                    model.elements[1],
                    {"floor": model.levels[0]},
                    {item.id: item for item in model.elements},
                )
                assert np.allclose(
                    (anchor @ [0, 0, 0, 1])[:3], components["thing"].bounds[0]
                )
                assert np.allclose(
                    (anchor @ [1, 1, 1, 1])[:3], components["thing"].bounds[1]
                )
                moved = move_object(
                    model,
                    Placement(
                        expected_revision=1,
                        element_id="thing",
                        translation=[1, 0, -1],
                        yaw=math.pi / 2,
                    ),
                )
                assert np.allclose(
                    component_meshes(moved)["thing"].bounds.mean(axis=0),
                    components["thing"].bounds.mean(axis=0) + [1, 0, -1],
                )
                attached_raw = model.model_dump()
                attached_raw["elements"][1]["attachment"] = {"host": "slab"}
                attached = Architecture.model_validate(attached_raw)
                assert not inspect_geometry(attached)["issues"]
                rendered = build_mesh(model)
                cache_before = assets._parts.cache_info()
                reused = component_meshes(model, rendered)
                assert assets._parts.cache_info() == cache_before
                for component_id in components:
                    assert np.allclose(
                        reused[component_id].bounds, components[component_id].bounds
                    )
                    assert len(reused[component_id].faces) == len(
                        components[component_id].faces
                    )
                assert np.allclose(
                    assets.linear_rgba("#808080", 0.4),
                    [0.2158605, 0.2158605, 0.2158605, 0.4],
                )
                exported = rendered.export(file_type="glb")
                reload = trimesh.load_scene(
                    io.BytesIO(exported), file_type="glb", process=False
                )
                assert (
                    sum(
                        mesh.metadata.get("element_id") == "thing"
                        for mesh in reload.geometry.values()
                    )
                    == 2
                )
                base = f"/api/maps/{job['id']}"
                published = await client.post(
                    base + "/architecture",
                    json={"expected_revision": 0, "document": model.model_dump()},
                )
                assert published.status_code == 200, published.text
                scene = (await client.get(base + "/scene")).json()
                assert (
                    scene["components"]["thing"]["anchor_matrix"]
                    and scene["components"]["thing"]["footprint"]
                    and scene["assets"][identifier]["id"] == identifier
                )
                assert not scene["localizable"] and not scene["cameras"]
                assert (
                    await client.post(
                        base + "/architecture",
                        json={"expected_revision": 0, "document": model.model_dump()},
                    )
                ).status_code == 409
                missing = model.model_dump()
                missing["elements"][1]["asset_id"] = "0" * 64
                assert (
                    await client.post(
                        base + "/architecture",
                        json={"expected_revision": 1, "document": missing},
                    )
                ).status_code == 422
                assert store.get_job(job["id"])["revision"] == 1
                assert (await client.get("/api/assets/" + "0" * 64)).status_code == 404
                normalized = assets.asset_file(identifier)
                normalized.write_bytes(b"corruption fixture")
                assert (
                    await client.get(f"/api/assets/{identifier}/model")
                ).status_code == 404
        finally:
            assets._parts.cache_clear()
            config.DATA, store.DATA, config.ACCESS_TOKEN = original
    print(
        "PASS: real asset storage/import/authoring, evidence, normalization, materials, instance geometry and HTTP boundaries"
    )


if __name__ == "__main__":
    asyncio.run(main())

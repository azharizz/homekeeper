"""Geometry and revision checks with isolated storage and the real HTTP app."""

import asyncio
import copy
import sys
import tempfile
from pathlib import Path

import httpx
import numpy as np
import trimesh
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, store
from app.architecture import Architecture, Placement, build_mesh, measure, move_object
from app.main import app

common = dict(
    level="ground",
    sources=["00000.jpg"],
    evidence="Unit geometry fixture; dimensions not measured.",
    color="#b8c6a0",
)
document = dict(
    title="Geometry boundary check",
    notes=["Not an acceptance home."],
    levels=[
        dict(id="ground", name="Ground", elevation=0),
        dict(id="upper", name="Upper", elevation=3),
    ],
    elements=[
        dict(
            common,
            id="floor",
            label="Floor with hole",
            kind="slab",
            polygon=[[0, 0], [4, 0], [4, 4], [0, 4]],
            holes=[[[1, 1], [1, 2], [2, 2], [2, 1]]],
            thickness=0.2,
        ),
        dict(
            common,
            id="wall",
            label="Wall with door",
            kind="wall",
            start=[0, 0],
            end=[4, 0],
            height=3,
            thickness=0.2,
            openings=[dict(kind="door", offset=1, width=1, sill=0, height=2)],
        ),
        dict(
            common,
            id="stairs",
            label="Stairs",
            kind="stair",
            to_level="upper",
            start=[3, 0],
            end=[3, 4],
            width=1,
            risers=15,
            tread_thickness=0.04,
        ),
        dict(
            common,
            id="rail",
            label="Inclined rail",
            kind="rail",
            start=[2.5, 1, 0],
            end=[2.5, 4, 4],
            radius=0.025,
        ),
    ],
)


def geometry_check():
    model = Architecture.model_validate(document)
    mesh = build_mesh(model)
    floor, wall, stair = (mesh.geometry[key] for key in ["floor", "wall", "stairs"])
    assert np.isclose(floor.volume, 15 * 0.2)
    assert np.allclose(floor.bounds[:, 1], [-0.2, 0])
    top_faces = floor.triangles[np.all(np.isclose(floor.triangles[:, :, 1], 0), axis=1)]
    # The actual horizontal triangles exclude the square hole.
    assert len(top_faces) and not any(
        1 < p[0] < 2 and 1 < p[2] < 2 for p in top_faces.mean(axis=1)
    )
    assert np.isclose(wall.volume, (4 * 3 - 1 * 2) * 0.2)
    assert all(
        not (
            part.bounds[0, 0] < 1.5 < part.bounds[1, 0]
            and part.bounds[0, 1] < 1 < part.bounds[1, 1]
        )
        for part in wall.split(only_watertight=False)
    )
    assert np.isclose(stair.bounds[1, 1], 3)
    rotated = copy.deepcopy(document)
    rotated["elements"][1].update(start=[0, 0], end=[0, 4])
    rotated_wall = build_mesh(Architecture.model_validate(rotated)).geometry["wall"]
    assert np.allclose(rotated_wall.bounds[:, 0], [-0.1, 0.1]) and np.allclose(
        rotated_wall.bounds[:, 2], [0, 4]
    )
    for change in ["duplicate", "outside_hole", "opening", "destination", "infinite"]:
        invalid = copy.deepcopy(document)
        if change == "duplicate":
            invalid["elements"][1]["id"] = "floor"
        if change == "outside_hole":
            invalid["elements"][0]["holes"] = [[[5, 5], [6, 5], [6, 6]]]
        if change == "opening":
            invalid["elements"][1]["openings"][0]["width"] = 5
        if change == "destination":
            invalid["elements"][2]["to_level"] = "ground"
        if change == "infinite":
            invalid["levels"][0]["elevation"] = float("inf")
        try:
            Architecture.model_validate(invalid)
        except ValidationError:
            continue
        raise AssertionError(f"Accepted invalid {change}")
    print("PASS: slab hole, door aperture, wall rotation, stairs, invalid geometry")


def placement_check():
    detail = copy.deepcopy(document)
    detail["elements"] += [
        dict(
            common,
            id="seat",
            label="Rounded seat",
            kind="box",
            position=[1, 0.5, 1],
            size=[1, 0.2, 0.8],
            radius=0.08,
            assembly="Chair",
            finish="fabric",
        ),
        dict(
            common,
            id="back",
            label="Tilted back",
            kind="box",
            position=[1, 0.9, 1.35],
            size=[1, 0.6, 0.12],
            pitch=0.2,
            assembly="Chair",
        ),
        dict(
            common,
            id="pot",
            label="Cylindrical pot",
            kind="solid",
            shape="cylinder",
            position=[3, 0.3, 1],
            size=[0.4, 0.6, 0.4],
            opacity=0.5,
        ),
    ]
    model = Architecture.model_validate(detail)
    scene = build_mesh(model)
    rounded = scene.geometry["seat"].copy()
    # UV seams duplicate vertices; weld positions to test the actual closed surface.
    rounded.merge_vertices(merge_tex=True, merge_norm=True)
    assert len(rounded.faces) > 12 and rounded.is_watertight
    assert scene.geometry["seat"].visual.material.baseColorTexture is not None
    assert np.allclose(scene.geometry["pot"].extents, [0.4, 0.6, 0.4])
    assert np.isclose(scene.geometry["pot"].volume, np.pi * 0.2**2 * 0.6, rtol=0.01)
    assert scene.geometry["pot"].visual.material.alphaMode == "BLEND"
    original = measure(model, "seat", "pot")
    assert np.isclose(original["plan_gap"], 1.3, atol=0.002)
    shifted = move_object(
        model,
        Placement(
            expected_revision=1,
            element_id="seat",
            translation=[0.4, 0.2, -0.1],
            yaw=np.pi / 2,
        ),
    )
    before = model.elements[-3:-1]
    after = shifted.elements[-3:-1]
    # Group rigid rotation preserves the distance between parts and the back's local tilt.
    assert np.isclose(
        np.linalg.norm(np.array(before[0].position) - before[1].position),
        np.linalg.norm(np.array(after[0].position) - after[1].position),
    )
    assert all(np.isclose(item.yaw, np.pi / 2) for item in after)
    assert (
        after[1].pitch == before[1].pitch and shifted.elements[-1] == model.elements[-1]
    )
    assert np.isclose(after[0].position[1] - before[0].position[1], 0.2)
    try:
        move_object(model, Placement(expected_revision=1, element_id="stairs"))
    except ValueError:
        pass
    else:
        raise AssertionError("Structural move accepted")
    invalid = copy.deepcopy(detail)
    invalid["elements"][-3]["radius"] = 0.5
    try:
        Architecture.model_validate(invalid)
    except ValidationError:
        pass
    else:
        raise AssertionError("Invalid bevel radius accepted")
    print(
        "PASS: curved geometry, PBR finish, rotated assembly, conservative measurement, structural guard"
    )


async def api_check():
    original = store.DATA
    with tempfile.TemporaryDirectory() as directory:
        store.DATA = Path(directory)
        try:
            job = store.create_job(
                "Isolated revision check",
                {"engine": "architecture", "source": "photos"},
            )
            root = store.job_dir(job["id"])
            store.atomic_json(
                root / "frames.json", [dict(name=f"{i:05d}.jpg") for i in range(4)]
            )
            store.update_job(job["id"], status="awaiting_agent")
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://localhost",
                timeout=None,
                headers={"authorization": "Bearer " + config.ACCESS_TOKEN},
            ) as client:
                endpoint = f"/api/maps/{job['id']}"
                evidence = await client.get(endpoint + "/capture")
                assert (
                    evidence.status_code == 200 and len(evidence.json()["frames"]) == 4
                )
                payload = dict(expected_revision=0, document=document)
                first = await client.post(endpoint + "/architecture", json=payload)
                assert first.status_code == 200, first.text
                first_job = first.json()
                old = store.artifact_dir(first_job)
                saved = (old / "surface.glb").read_bytes()
                assert len(trimesh.load(old / "surface.glb").geometry) == 4
                stale = await client.post(endpoint + "/architecture", json=payload)
                assert stale.status_code == 409
                invalid = copy.deepcopy(payload)
                invalid["expected_revision"] = 1
                invalid["document"]["elements"][0]["sources"] = ["foreign.jpg"]
                assert (
                    await client.post(endpoint + "/architecture", json=invalid)
                ).status_code == 422
                assert (
                    store.get_job(job["id"])["revision"] == 1
                    and (old / "surface.glb").read_bytes() == saved
                )
                payload["expected_revision"] = 1
                second = await client.post(endpoint + "/architecture", json=payload)
                assert second.status_code == 200 and second.json()["revision"] == 2
                assert (
                    await client.get(
                        endpoint + "/artifacts/surface.glb",
                        params={"revision": first_job["artifact_revision"]},
                    )
                ).content == saved
                assert (
                    await client.get(
                        endpoint + "/artifacts/surface.glb",
                        params={"revision": "../escape"},
                    )
                ).status_code == 404
                scene = (await client.get(endpoint + "/scene")).json()
                assert (
                    scene["revision"] == 2
                    and scene["localizable"] is False
                    and scene["cameras"] == []
                )
                assert (
                    await client.post(
                        endpoint + "/scale",
                        json=dict(point_a=0, point_b=1, distance_m=1),
                    )
                ).status_code == 409
                measurement = await client.get(
                    endpoint + "/architecture/measure",
                    params={"first": "rail", "second": "wall"},
                )
                assert (
                    measurement.status_code == 200
                    and measurement.json()["revision"] == 2
                )
                assert (
                    await client.get(
                        endpoint + "/architecture/measure",
                        params={"first": "missing", "second": "wall"},
                    )
                ).status_code == 422
                placement = dict(
                    expected_revision=2,
                    element_id="rail",
                    translation=[0.2, 0, 0],
                    yaw=0,
                )
                moved = await client.post(
                    endpoint + "/architecture/placement", json=placement
                )
                assert moved.status_code == 200 and moved.json()["revision"] == 3, (
                    moved.text
                )
                assert (
                    await client.post(
                        endpoint + "/architecture/placement", json=placement
                    )
                ).status_code == 409
                placement.update(expected_revision=3, element_id="floor")
                assert (
                    await client.post(
                        endpoint + "/architecture/placement", json=placement
                    )
                ).status_code == 422
        finally:
            store.DATA = original
    print(
        "PASS: HTTP schema, GLB, revision conflict, invalid sources, history, unknown pose"
    )


geometry_check()
placement_check()
asyncio.run(api_check())

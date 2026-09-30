"""Runnable geometry, camera and API boundary checks. Synthetic math fixtures are not home acceptance data."""

import asyncio
import copy
import itertools
import math
import sys
import tempfile
from pathlib import Path

import cv2
import httpx
import numpy as np
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, store
from app.architecture import (
    Architecture,
    PhotoAlignment,
    Placement,
    anchor_matrix,
    build_mesh,
    move_object,
    slab_shape,
)
from app.architecture.alignment import fit_photo
from app.architecture.checks import inspect_geometry
from app.architecture.evidence import measurement_checks
from app.main import app

common = dict(
    level="ground",
    sources=["00000.jpg"],
    evidence="Isolated math fixture, not a home capture.",
    color="#998877",
)
raw = dict(
    title="Accuracy contracts",
    notes=["Synthetic unit geometry only."],
    levels=[
        dict(id="ground", name="Ground", elevation=0),
        dict(id="upper", name="Upper", elevation=3),
    ],
    elements=[
        dict(
            common,
            id="wall",
            kind="wall",
            label="Stacked windows",
            start=[0, 0],
            end=[4, 0],
            height=6,
            thickness=0.2,
            openings=[
                dict(id="lower", kind="window", offset=1, width=1, sill=1, height=1),
                dict(id="upper", kind="window", offset=1, width=1, sill=4, height=1),
            ],
        ),
        dict(
            common,
            id="floor",
            kind="slab",
            label="Ground",
            polygon=[[0, 0], [4, 0], [4, 5], [0, 5]],
            thickness=0.2,
        ),
        dict(
            common,
            id="landing",
            kind="slab",
            label="Landing",
            level="upper",
            polygon=[[0, 0], [4, 0], [4, 5], [0, 5]],
            holes=[[[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]]],
            thickness=0.2,
        ),
        dict(
            common,
            id="stair",
            kind="stair",
            label="Stair",
            start=[2, 0],
            end=[2, 4],
            width=1,
            risers=15,
            tread_thickness=0.03,
            to_level="upper",
            opening=dict(slab="landing"),
        ),
        dict(
            common,
            id="frame",
            kind="box",
            label="Wall hosted item",
            position=[0, 0, -0.15],
            size=[0.9, 0.9, 0.1],
            attachment=dict(host="wall", opening="upper"),
        ),
        dict(
            common,
            id="cube",
            kind="box",
            label="Floor hosted cube",
            position=[1, 0.5, 3],
            size=[1, 1, 1],
            attachment=dict(host="floor"),
        ),
    ],
)


def rejects(call):
    try:
        call()
    except (ValueError, ValidationError):
        return
    raise AssertionError("Invalid input accepted")


def geometry():
    model = Architecture.model_validate(raw)
    scene = build_mesh(model)
    assert np.isclose(scene.geometry["wall"].volume, (24 - 2) * 0.2)
    pieces = scene.geometry["wall"].split(only_watertight=False)
    for y in [1.5, 4.5]:
        assert not any(
            p.bounds[0, 0] < 1.5 < p.bounds[1, 0]
            and p.bounds[0, 1] < y < p.bounds[1, 1]
            for p in pieces
        )
    assert any(
        p.bounds[0, 0] < 1.5 < p.bounds[1, 0] and p.bounds[0, 1] < 3 < p.bounds[1, 1]
        for p in pieces
    )
    bad = copy.deepcopy(raw)
    bad["elements"][0]["openings"][1]["sill"] = 1.5
    rejects(lambda: Architecture.model_validate(bad))
    assert np.allclose(scene.geometry["frame"].bounds.mean(axis=0), [1.5, 4.5, -0.15])
    changed = copy.deepcopy(raw)
    changed["elements"][0].update(start=[5, 0], end=[5, 4])
    changed["elements"][0]["openings"][1]["sill"] = 3
    moved = build_mesh(Architecture.model_validate(changed))
    assert np.allclose(moved.geometry["frame"].bounds.mean(axis=0), [5.15, 3.5, 1.5])
    assert np.allclose(scene.geometry["cube"].bounds[0, 1], 0)
    rejects(
        lambda: move_object(
            model,
            Placement(expected_revision=1, element_id="cube", translation=[0, 1, 0]),
        )
    )
    elements = {e.id: e for e in model.elements}
    shape = slab_shape(elements["landing"], elements)
    assert np.isclose(shape.area, 20 - 0.04 - 4)
    assert model.elements[2].holes == [list(map(tuple, raw["elements"][2]["holes"][0]))]
    # The edge-touching notch remains a valid slab and follows the stair.
    changed = copy.deepcopy(raw)
    changed["elements"][3].update(start=[3, 0], end=[3, 4])
    shifted = Architecture.model_validate(changed)
    assert np.isclose(
        build_mesh(shifted).geometry["landing"].volume, (20 - 0.04 - 4) * 0.2
    )
    report = inspect_geometry(model)
    assert not any(
        i["code"]
        in {
            "stair_slab_intersection",
            "stair_landing_unsupported",
            "slab_attachment_height",
        }
        for i in report["issues"]
    ), report
    unlinked = copy.deepcopy(raw)
    unlinked["elements"][3].pop("opening")
    codes = {
        i["code"]
        for i in inspect_geometry(Architecture.model_validate(unlinked))["issues"]
    }
    assert {"stair_opening_unlinked", "stair_slab_intersection"} <= codes
    edge = copy.deepcopy(raw)
    edge["elements"][2].update(polygon=[[0, 4], [4, 4], [4, 5], [0, 5]], holes=[])
    edge["elements"][3]["opening"]["mode"] = "edge"
    edge_model = Architecture.model_validate(edge)
    assert np.isclose(build_mesh(edge_model).geometry["landing"].volume, 4 * 0.2)
    assert not any(
        i["code"].startswith("stair_") for i in inspect_geometry(edge_model)["issues"]
    )
    edge["elements"][2]["polygon"] = [[1.75, 4], [2.25, 4], [2.25, 5], [1.75, 5]]
    assert "stair_landing_unsupported" in {
        i["code"] for i in inspect_geometry(Architecture.model_validate(edge))["issues"]
    }
    edge["elements"][2]["polygon"] = [[0, 4.5], [4, 4.5], [4, 5], [0, 5]]
    assert "stair_landing_unsupported" in {
        i["code"] for i in inspect_geometry(Architecture.model_validate(edge))["issues"]
    }
    invalid = copy.deepcopy(raw)
    invalid["elements"][3]["opening"]["slab"] = "floor"
    rejects(lambda: Architecture.model_validate(invalid))
    invalid = copy.deepcopy(raw)
    invalid["elements"][4]["attachment"]["opening"] = "missing"
    rejects(lambda: Architecture.model_validate(invalid))
    blocked = copy.deepcopy(raw)
    blocked["elements"][0]["openings"][0]["kind"] = "door"
    blocked["elements"][4].update(position=[1.5, 1.5, 0], attachment=dict(host="wall"))
    assert "door_aperture_overlap" in {
        i["code"]
        for i in inspect_geometry(Architecture.model_validate(blocked))["issues"]
    }
    blocked["elements"][4].update(
        position=[0, 0, 0], attachment=dict(host="wall", opening="lower")
    )
    assert "door_aperture_overlap" not in {
        i["code"]
        for i in inspect_geometry(Architecture.model_validate(blocked))["issues"]
    }
    print(
        "PASS: stacked apertures, wall/opening transforms, supported attachment, linked stair notch, preserved holes, model conflict diagnostics"
    )
    return model


def camera(model):
    levels = {e.id: e for e in model.levels}
    elements = {e.id: e for e in model.elements}
    matrix = anchor_matrix(elements["cube"], levels, elements)
    anchors = list(itertools.product([0, 1], repeat=3))
    world = np.array([(matrix @ [*a, 1])[:3] for a in anchors])
    size, fov = [1200, 900], 55
    f = size[1] / (2 * math.tan(math.radians(fov) / 2))
    intrinsic = np.array([[f, 0, 600], [0, f, 450], [0, 0, 1.0]])
    rotation, translation = np.array([0.2, -0.3, 0.08]), np.array([-1.0, -0.5, 6.0])
    pixels = cv2.projectPoints(world, rotation, translation, intrinsic, None)[
        0
    ].reshape(-1, 2)
    alignment = PhotoAlignment(
        source="00000.jpg",
        fov_y=fov,
        matches=[
            dict(element_id="cube", anchor=a, image=uv, note=f"Corner {i}")
            for i, (a, uv) in enumerate(zip(anchors, pixels / size))
        ],
    )
    fit = fit_photo(model, alignment, size)
    assert fit["rmse_px"] < 1e-4, fit
    expected = np.eye(4)
    expected[:3, :3], expected[:3, 3] = cv2.Rodrigues(rotation)[0], translation
    assert np.allclose(fit["world_to_camera"], expected, atol=1e-5)
    assert np.allclose(
        np.array(fit["camera_to_world"]) @ np.diag([1, -1, -1, 1]),
        np.linalg.inv(expected),
        atol=1e-5,
    )
    perturbed = alignment.model_dump()
    perturbed["matches"][0]["image"] = [
        pixels[0, 0] / size[0] + 0.06,
        pixels[0, 1] / size[1],
    ]
    conflict = fit_photo(model, PhotoAlignment.model_validate(perturbed), size)
    assert conflict["rmse_px"] > 5 and len(conflict["matches"]) == 8
    duplicate = alignment.model_dump()
    duplicate["matches"] = [duplicate["matches"][0]] * 6
    rejects(lambda: fit_photo(model, PhotoAlignment.model_validate(duplicate), size))
    held_out = alignment.model_dump()
    for match in held_out["matches"][6:]:
        match["role"] = "check"
    baseline = fit_photo(model, PhotoAlignment.model_validate(held_out), size)
    held_out["matches"][6]["image"] = [
        held_out["matches"][6]["image"][0] + 0.05,
        held_out["matches"][6]["image"][1],
    ]
    checked = fit_photo(model, PhotoAlignment.model_validate(held_out), size)
    assert checked["fit_count"] == 6 and checked["check_count"] == 2
    assert checked["rmse_px"] < 1e-4 and checked["check_max_error_px"] > 59
    assert np.allclose(checked["camera_to_world"], baseline["camera_to_world"])
    held_out["matches"][5]["role"] = "check"
    rejects(lambda: fit_photo(model, PhotoAlignment.model_validate(held_out), size))
    print(
        "PASS: known PnP pose, pixel reprojection, OpenCV/Three.js conversion, contradictory match residuals, degenerate rejection"
    )
    return alignment, size


def measurements(model):
    value = model.model_dump()
    value["measurements"] = [
        dict(
            id="cube_width",
            label="Synthetic width check",
            start=dict(element_id="cube", anchor=[0, 0, 0]),
            end=dict(element_id="cube", anchor=[1, 0, 0]),
            distance_m=1.1,
            uncertainty_m=0.02,
            provenance="Synthetic test input only, not a measurement of a home.",
        )
    ]
    tested = Architecture.model_validate(value)
    report = measurement_checks(tested)[0]
    assert np.isclose(report["model_distance_m"], 1)
    assert np.isclose(report["residual_m"], -0.1)
    assert not report["within_reported_uncertainty"]
    moved = copy.deepcopy(value)
    moved["elements"][-1]["size"] = [1.1, 1, 1]
    assert measurement_checks(Architecture.model_validate(moved))[0][
        "within_reported_uncertainty"
    ]
    bad = copy.deepcopy(value)
    bad["measurements"][0]["end"] = bad["measurements"][0]["start"]
    rejects(lambda: measurement_checks(Architecture.model_validate(bad)))
    bad["measurements"][0]["end"]["element_id"] = "missing"
    rejects(lambda: Architecture.model_validate(bad))
    value["measurements"][0]["uncertainty_m"] = 0
    rejects(lambda: Architecture.model_validate(value))
    print(
        "PASS: measured evidence residuals, geometry edits, uncertainty, missing and coincident anchors"
    )
    return tested


async def api(model, alignment, size):
    original = store.DATA
    with tempfile.TemporaryDirectory() as directory:
        store.DATA = Path(directory)
        try:
            job = store.create_job(
                "Accuracy check", {"engine": "architecture", "source": "photos"}
            )
            store.atomic_json(
                store.job_dir(job["id"]) / "frames.json",
                [dict(name=f"{i:05d}.jpg", size=size) for i in range(4)],
            )
            store.update_job(job["id"], status="awaiting_agent")
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://localhost",
                timeout=None,
                headers={"authorization": "Bearer " + config.ACCESS_TOKEN},
            ) as client:
                url = f"/api/maps/{job['id']}"
                published = await client.post(
                    url + "/architecture",
                    json=dict(expected_revision=0, document=model.model_dump()),
                )
                assert published.status_code == 200, published.text
                old = store.artifact_dir(store.get_job(job["id"]))
                original_mesh = (old / "surface.glb").read_bytes()
                accuracy = await client.get(url + "/architecture/accuracy")
                assert accuracy.status_code == 200, accuracy.text
                report = accuracy.json()
                assert report["revision"] == 1 and not report["physically_verified"]
                assert len(report["measurements"]) == 1 and report[
                    "surface_bytes"
                ] == len(original_mesh)
                immutable = await client.get(
                    url + "/artifacts/surface.glb", params={"revision": old.name}
                )
                latest = await client.get(url + "/artifacts/surface.glb")
                assert "immutable" in immutable.headers["cache-control"]
                assert latest.headers["cache-control"] == "no-store"
                invalid = model.model_dump()
                invalid["measurements"][0]["end"] = invalid["measurements"][0]["start"]
                rejected = await client.post(
                    url + "/architecture",
                    json=dict(expected_revision=1, document=invalid),
                )
                assert (
                    rejected.status_code == 422
                    and store.get_job(job["id"])["revision"] == 1
                )
                payload = dict(
                    expected_revision=1, alignment=alignment.model_dump(), save=False
                )
                preview = await client.post(
                    url + "/architecture/alignment", json=payload
                )
                assert (
                    preview.status_code == 200
                    and preview.json()["fit"]["rmse_px"] < 1e-4
                ), preview.text
                assert store.get_job(job["id"])["revision"] == 1
                payload["save"] = True
                saved = await client.post(url + "/architecture/alignment", json=payload)
                assert saved.status_code == 200 and saved.json()["revision"] == 2
                assert (
                    await client.post(url + "/architecture/alignment", json=payload)
                ).status_code == 409
                payload["expected_revision"] = 2
                payload["alignment"]["source"] = "foreign.jpg"
                assert (
                    await client.post(url + "/architecture/alignment", json=payload)
                ).status_code == 422
                assert store.get_job(job["id"])["revision"] == 2
                assert (old / "surface.glb").read_bytes() == original_mesh
                scene = (await client.get(url + "/scene")).json()
                assert (
                    not scene["localizable"]
                    and scene["cameras"] == []
                    and len(scene["photo_alignments"]) == 1
                )
                assert (
                    scene["components"]["landing"]["surfaces"]
                    and scene["components"]["cube"]["anchor_matrix"]
                )
                assert (await client.get(url + "/architecture/checks")).json()[
                    "revision"
                ] == 2
        finally:
            store.DATA = original
    print(
        "PASS: real HTTP preview/save, schema, conflict, foreign image rejection, immutable history, fits remain separate from live pose"
    )


model = geometry()
alignment, size = camera(model)
model = measurements(model)
asyncio.run(api(model, alignment, size))

"""Numerical and HTTP contracts, not physical-home acceptance evidence."""

import asyncio
import itertools
import sys
import tempfile
from pathlib import Path

import cv2
import httpx
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, store
from app.architecture import Architecture, PhotoAlignment
from app.architecture.alignment import fit_photo, world_points
from app.architecture.refinement import (
    RefinementRequest,
    refine,
    propose_scale,
    scale_document,
)
from app.architecture.landmarks import build_landmarks
from app.main import app


def fixture():
    common = {
        "kind": "box",
        "level": "floor",
        "color": "#aaaabb",
        "sources": ["00000.jpg", "00001.jpg"],
        "evidence": "Numerical test only.",
    }
    value = {
        "title": "Math fixture",
        "notes": ["No real home accuracy claim."],
        "levels": [{"id": "floor", "name": "Floor", "elevation": 0}],
        "elements": [
            common
            | {
                "id": "fixed",
                "label": "Fixed reference",
                "position": [-1, 0.5, 0],
                "size": [1, 1, 1],
            },
            common
            | {
                "id": "moving",
                "label": "Selected object",
                "position": [1, 0.5, 1],
                "size": [1, 1, 1],
            },
        ],
    }
    model = Architecture.model_validate(value)
    matches = [
        dict(
            element_id=e,
            anchor=list(a),
            note=f"{e} {i}",
            role="check" if i == 7 else "fit",
            image=[0, 0],
        )
        for e in ["fixed", "moving"]
        for i, a in enumerate(itertools.product([0.0, 1.0], repeat=3))
    ]
    points = world_points(
        model,
        [
            __import__("app.architecture", fromlist=["PhotoMatch"]).PhotoMatch(**m)
            for m in matches
        ],
    )
    k = np.array([[800.0, 0, 620], [0, 830, 430], [0, 0, 1]])
    for i, (r, t) in enumerate(
        [
            (np.array([0.1, -0.2, 0.03]), np.array([0.0, -0.5, 7.0])),
            (np.array([-0.1, 0.25, -0.03]), np.array([-0.4, -0.2, 6.0])),
        ]
    ):
        px = cv2.projectPoints(points, r, t, k, np.zeros(5))[0].reshape(-1, 2)
        a = PhotoAlignment(
            source=f"{i:05d}.jpg",
            fov_y=60,
            calibration=dict(
                width=1200,
                height=900,
                fx=800,
                fy=830,
                cx=620,
                cy=430,
                provenance="Known numerical fixture.",
            ),
            matches=[m | {"image": list(p / [1200, 900])} for m, p in zip(matches, px)],
        )
        model.alignments.append(a)
    model.elements[1].position = (1.3, 0.5, 1)
    return model, [{"name": f"{i:05d}.jpg", "size": [1200, 900]} for i in range(4)]


def numerical():
    doc, frames = fixture()
    request = RefinementRequest(
        expected_revision=1,
        parameters=[
            dict(element_id="moving", field="position", axis=0, minimum=0.5, maximum=2)
        ],
    )
    result = refine(doc, frames, request)
    assert result["solver"]["locally_observable"], result["solver"]
    assert abs(result["document"]["elements"][1]["position"][0] - 1) < 1e-5
    assert max(f["check_rmse_px"] for f in result["after"]) < 1e-4
    assert min(f["check_rmse_px"] for f in result["before"]) > 1
    altered = doc.model_copy(deep=True)
    for a in altered.alignments:
        a.matches[-1].image = (a.matches[-1].image[0] + 0.02, a.matches[-1].image[1])
    check = refine(altered, frames, request)
    assert np.allclose(
        check["document"]["elements"][1]["position"],
        result["document"]["elements"][1]["position"],
        atol=1e-6,
    )
    assert min(f["check_rmse_px"] for f in check["after"]) > 10
    a = doc.alignments[0]
    fit = fit_photo(doc, a, [600, 450])
    assert fit["intrinsic"][0][0] == 400 and fit["intrinsic"][1][2] == 215
    measurement = dict(
        id="width",
        label="Fixture width",
        start=dict(element_id="fixed", anchor=[0, 0, 0]),
        end=dict(element_id="fixed", anchor=[1, 0, 0]),
        distance_m=2,
        uncertainty_m=0.01,
        provenance="Known synthetic length, not home evidence.",
    )
    raw = doc.model_dump()
    raw["measurements"] = [measurement]
    measured = Architecture.model_validate(raw)
    scaled = propose_scale(measured, ["width"])
    assert scaled["scale_factor"] == 2 and scaled["after"][0]["model_distance_m"] == 2
    assert scaled["document"]["measurements"][0]["distance_m"] == 2
    for old, new in zip(
        measured.alignments, Architecture.model_validate(scaled["document"]).alignments
    ):
        assert old == new
    from check_architecture_accuracy import raw as attached_fixture
    from app.architecture import build_mesh

    attached = Architecture.model_validate(attached_fixture)
    scaled_attached = scale_document(attached, 1.7)
    before_mesh, after_mesh = build_mesh(attached), build_mesh(scaled_attached)
    for key, mesh in before_mesh.geometry.items():
        assert np.allclose(after_mesh.geometry[key].bounds, mesh.bounds * 1.7), key
    assert scaled_attached.elements[3].risers == attached.elements[3].risers
    print(
        "PASS: joint camera/geometry recovery, excluded-check independence, asymmetric intrinsics resize, evidence-constrained scale"
    )
    return doc, frames, request


async def routes(doc, frames, request):
    original = store.DATA
    with tempfile.TemporaryDirectory() as tmp:
        store.DATA = Path(tmp)
        try:
            job = store.create_job("Fixture", {"engine": "architecture"})
            root = store.job_dir(job["id"])
            (root / "images").mkdir()
            for f in frames:
                Image.new("RGB", tuple(f["size"]), "white").save(
                    root / "images" / f["name"]
                )
            store.atomic_json(root / "frames.json", frames)
            store.update_job(job["id"], status="awaiting_agent")
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://localhost",
                headers={"authorization": "Bearer " + config.ACCESS_TOKEN},
                timeout=None,
            ) as client:
                url = "/api/maps/" + job["id"] + "/architecture"
                r = await client.post(
                    url, json={"expected_revision": 0, "document": doc.model_dump()}
                )
                assert r.status_code == 200, r.text
                r = await client.post(url + "/refine", json=request.model_dump())
                assert r.status_code == 200, r.text
                result = r.json()
                assert store.get_job(job["id"])["revision"] == 1
                overlay = await client.post(
                    url + "/overlay",
                    json={
                        "expected_revision": 1,
                        "source": "00000.jpg",
                        "document": result["document"],
                    },
                )
                assert overlay.status_code == 200 and overlay.content.startswith(
                    b"\x89PNG"
                )
                r = await client.post(url + "/landmarks", json={"expected_revision": 1})
                assert r.status_code == 422, r.text
                r = await client.post(
                    url, json={"expected_revision": 1, "document": result["document"]}
                )
                assert r.status_code == 200, r.text
                r = await client.post(url + "/refine", json=request.model_dump())
                assert r.status_code == 409
                r = await client.post(
                    url + "/scale-proposal",
                    json={"expected_revision": 2, "measurement_ids": ["missing"]},
                )
                assert r.status_code == 422
                measurement = dict(
                    id="reported_width",
                    label="Fixture measurement",
                    start=dict(element_id="fixed", anchor=[0, 0, 0]),
                    end=dict(element_id="fixed", anchor=[1, 0, 0]),
                    distance_m=2,
                    uncertainty_m=0.01,
                    provenance="Synthetic API test, not physical evidence.",
                )
                r = await client.post(
                    url + "/measurements",
                    json={"expected_revision": 2, "measurement": measurement},
                )
                assert r.status_code == 200, r.text
                assert store.get_job(job["id"])["revision"] == 3
                r = await client.post(
                    url + "/measurements",
                    json={"expected_revision": 3, "measurement": measurement},
                )
                assert r.status_code == 409, r.text
                r = await client.post(
                    url + "/scale-proposal",
                    json={
                        "expected_revision": 3,
                        "measurement_ids": ["reported_width"],
                    },
                )
                assert r.status_code == 200 and r.json()["scale_factor"] == 2, r.text
                assert store.get_job(job["id"])["revision"] == 3
                r = await client.get(url + "/guidance")
                assert r.status_code == 409
                r = await client.post(
                    url + "/overlay", json={"expected_revision": 3, "source": "../.env"}
                )
                assert r.status_code == 422
        finally:
            store.DATA = original
    print(
        "PASS: real ASGI preview/overlay, no implicit mutation, conflict handling, missing measurement/index and foreign-source rejection"
    )


if __name__ == "__main__":
    doc, frames, request = numerical()
    asyncio.run(routes(doc, frames, request))


def landmark_localization():
    from app.architecture import publish
    from app.localization import localize, load_index

    rng = np.random.default_rng(7)
    pixels = np.uint8(rng.uniform(0, 255, (600, 800)))
    pixels = cv2.GaussianBlur(pixels, (5, 5), 0.9)
    sift = cv2.SIFT_create(nfeatures=600)
    keys = sift.detect(pixels, None)
    chosen = []
    for key in sorted(keys, key=lambda k: -k.response):
        x, y = key.pt
        if not (60 < x < 740 and 60 < y < 540) or any(
            np.linalg.norm(np.array(key.pt) - k.pt) < 45 for k in chosen
        ):
            continue
        chosen.append(key)
        if len(chosen) == 32:
            break
    assert len(chosen) == 32
    k = np.array([[800.0, 0, 400], [0, 800, 300], [0, 0, 1.0]])
    world = []
    for i, key in enumerate(chosen):
        ray = np.linalg.inv(k) @ [*key.pt, 1]
        world.append(ray * (4 + (i % 5) * 0.3))
    raw = {
        "title": "Descriptor fixture",
        "notes": ["Random texture mathematical test only."],
        "levels": [{"id": "floor", "name": "Floor", "elevation": 0}],
        "elements": [],
        "alignments": [],
    }
    for i, point in enumerate(world):
        raw["elements"].append(
            dict(
                id=f"p{i}",
                kind="box",
                label=f"Test landmark {i}",
                level="floor",
                color="#aaaaaa",
                sources=["00000.jpg", "00001.jpg"],
                evidence="Known math fixture.",
                position=point.tolist(),
                size=[0.01, 0.01, 0.01],
            )
        )
    for i in range(2):
        raw["alignments"].append(
            dict(
                source=f"{i:05d}.jpg",
                fov_y=60,
                calibration=dict(
                    width=800,
                    height=600,
                    fx=800,
                    fy=800,
                    cx=400,
                    cy=300,
                    provenance="Known numeric test lens.",
                ),
                matches=[
                    dict(
                        element_id=f"p{j}",
                        anchor=[0.5, 0.5, 0.5],
                        image=[key.pt[0] / 800, key.pt[1] / 600],
                        note="Detected feature in numerical fixture.",
                    )
                    for j, key in enumerate(chosen)
                ],
            )
        )
    model = Architecture.model_validate(raw)
    original = store.DATA
    with tempfile.TemporaryDirectory() as tmp:
        store.DATA = Path(tmp)
        try:
            job = store.create_job("Descriptor fixture", {"engine": "architecture"})
            root = store.job_dir(job["id"])
            (root / "images").mkdir()
            frames = [dict(name=f"{i:05d}.jpg", size=[800, 600]) for i in range(4)]
            for f in frames:
                Image.fromarray(pixels).convert("RGB").save(
                    root / "images" / f["name"], quality=100, subsampling=0
                )
            store.atomic_json(root / "frames.json", frames)
            job = publish(job, model, 0)
            index = build_landmarks(job)
            assert index["landmark_count"] >= 20, index["landmark_count"]
            assert len(index["source_images"]) == 2
            assert all(len(p["sha256"]) == 64 for p in index["source_images"])
            assert len(index["geometry"]) == 32 and "structure" in index
            # Pure optical rotation gives a known new projection, with no invented physical trial.
            r = cv2.Rodrigues(np.array([0.01, 0.035, -0.015]))[0]
            query = cv2.warpPerspective(pixels, k @ r @ np.linalg.inv(k), (800, 600))
            path = root / "query.jpg"
            Image.fromarray(query).convert("RGB").save(path, quality=100, subsampling=0)
            calibration = {
                "model": "PINHOLE",
                "width": 800,
                "height": 600,
                "params": [800, 800, 400, 300],
            }
            result = localize(job["id"], path, calibration)
            assert result["status"] == "localized", result
            assert np.linalg.norm(result["position"]) < 0.1, result
            assert np.allclose(
                np.array(result["world_to_camera"])[:3, :3], r, atol=0.025
            ), result
            Image.new("RGB", (800, 600), "white").save(path)
            assert localize(job["id"], path, calibration)["status"] == "lost"
            publish(job, model, 1)
            assert localize(job["id"], path, calibration)["status"] == "lost"
            print(
                f"PASS: actual SIFT index ({index['index_bytes']} bytes), rotated-image geometric pose, blank-frame loss and revision isolation"
            )
        finally:
            load_index.cache_clear()
            store.DATA = original


if __name__ == "__main__":
    landmark_localization()

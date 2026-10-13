"""Isolated Aria-shaped mock capture; no saved Space, media, HTTP service or physical trial."""

import copy
import itertools
import json
import math
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import store
from app.architecture import Architecture, publish
from app.architecture.alignment import fit_photos
from app.architecture.landmarks import guidance
from app.api.architecture import LandmarkRequest, create_architecture_landmarks
from app.api.maps import parse_calibration, scene as read_scene
from app.localization import localize


SIZE = (800, 600)
K = np.array([[800., 0, 400], [0, 800, 300], [0, 0, 1]])
ANCHORS = [*itertools.product([0., 1.], repeat=3), (0.3, 0.4, 0.5)]
WORLD = np.array(ANCHORS) - 0.5
CALIBRATION = dict(model="PINHOLE", width=800, height=600, params=[800, 800, 400, 300])


def fixture():
    document = {
        "title": "Aria-shaped mock room (not the saved demo)",
        "notes": ["Synthetic camera math only; no measured physical evidence."],
        "levels": [{"id": "ground", "name": "Ground", "elevation": 0}],
        "elements": [{
            "id": "room_anchor", "kind": "box", "label": "Mock observed corners",
            "level": "ground", "sources": ["00000.jpg", "00001.jpg"],
            "evidence": "Synthetic unit fixture, not real observations.",
            "position": [0, 0, 0], "size": [1, 1, 1], "color": "#aaaaaa",
        }],
        "alignments": [],
    }
    pixels = []
    for i in range(2):
        uv = cv2.projectPoints(WORLD, np.array([0.1, -0.2, 0.05]),
                               np.array([i * 0.3, 0., 4.]), K, None)[0].reshape(-1, 2)
        pixels.extend(uv)
        document["alignments"].append({
            "source": f"{i:05d}.jpg", "fov_y": math.degrees(2 * math.atan(300 / 800)),
            "matches": [{
                "element_id": "room_anchor", "anchor": anchor,
                "image": (point / SIZE).tolist(), "note": "Mock observed corner.",
                "role": "check" if j == 8 else "fit",
            } for j, (anchor, point) in enumerate(zip(ANCHORS, uv))],
        })
    return document, pixels


class MockSift:
    """Mock image-feature extraction only; actual fit, landmark algorithm and publication run."""
    def __init__(self, pixels):
        self.keys = [cv2.KeyPoint(float(p[0]), float(p[1]), 5, 0) for p in pixels]

    def detect(self, image, mask):
        return self.keys

    def compute(self, image, keys):
        descriptor = np.ones((len(keys), 128), dtype=np.float32)
        return keys, descriptor


def check():
    original = store.DATA
    raw, pixels = fixture()
    with tempfile.TemporaryDirectory() as directory:
        store.DATA = Path(directory)
        try:
            job = store.create_job("Isolated aria-dino-shaped mock", {
                "engine": "architecture", "source": "photos", "calibration": CALIBRATION,
            })
            root = store.job_dir(job["id"])
            (root / "images").mkdir()
            frames = [{"name": f"{i:05d}.jpg", "size": list(SIZE)} for i in range(2)]
            for frame in frames:
                Image.new("RGB", SIZE, "gray").save(root / "images" / frame["name"])
            store.atomic_json(root / "frames.json", frames)
            job = store.update_job(job["id"], status="awaiting_agent")
            parsed = parse_calibration(json.dumps(CALIBRATION))
            assert parsed == CALIBRATION
            try:
                parse_calibration('{"model":"NO_SUCH_CAMERA","width":800,"height":600,"params":[1]}')
            except HTTPException as error:
                assert error.status_code == 422
            else:
                raise AssertionError("Invalid calibration accepted")
            model = Architecture.model_validate(raw)
            fits = fit_photos(model, frames, parsed)
            assert all(f["calibration_supplied"] and f["check_count"] == 1 for f in fits)
            assert all(f["check_max_error_px"] < 0.001 for f in fits)
            # Non-square pinhole and supported distortion models preserve genuine parameters.
            for lens, params, distortion in [
                ("SIMPLE_PINHOLE", [800, 400, 300], [0, 0, 0, 0, 0]),
                ("SIMPLE_RADIAL", [800, 400, 300, 0.01], [0.01, 0, 0, 0, 0]),
                ("RADIAL", [800, 400, 300, 0.01, 0.001], [0.01, 0.001, 0, 0, 0]),
                ("OPENCV", [800, 810, 400, 300, 0.01, 0.001, 0.002, 0.003], [0.01, 0.001, 0.002, 0.003, 0]),
            ]:
                supported = fit_photos(model, frames, CALIBRATION | {"model": lens, "params": params})
                assert np.allclose(supported[0]["distortion"], distortion)
            with patch("app.architecture.landmarks.cv2.SIFT_create", return_value=MockSift(pixels)):
                commit = store.publish_revision
                def atomic_commit(identifier, expected, revision, summary):
                    staged = root / "architecture" / revision
                    pending = json.loads((staged / "scene.json").read_text())
                    index = guidance(staged)
                    assert pending["guide_readiness"]["ready"]
                    assert (staged / index["index_file"]).is_file()
                    assert store.get_job(identifier).get("revision", 0) == expected
                    return commit(identifier, expected, revision, summary)
                with patch("app.architecture.publication.store.publish_revision", side_effect=atomic_commit):
                    job = publish(job, model, 0)
                first = store.artifact_dir(job)
                preserved = {path.name: path.read_bytes() for path in first.iterdir()}
                value = read_scene(job["id"])
                assert value["localizable"] and value["guide_readiness"]["ready"]
                assert value["guide_readiness"]["validation"]["status"] == "passed"
                assert value["landmark_count"] == 8 and len(value["cameras"]) == 2
                assert value["scale"] is None and not value["guide_readiness"]["physically_verified"]
                assert len(guidance(first)["landmarks"]) == 8  # Check points never train.
                # Explicit rebuilding synchronizes scene status through a new atomic revision.
                rebuilt = create_architecture_landmarks(job["id"], LandmarkRequest(expected_revision=1))
                assert rebuilt["revision"] == 2 and rebuilt["guide_readiness"]["ready"]
                job = store.get_job(job["id"])
                assert all((first / name).read_bytes() == content for name, content in preserved.items())
                persisted = json.loads((first / "architecture.json").read_text())
                assert all(a["calibration"]["fx"] == 800 for a in persisted["alignments"])
                absent_checks = copy.deepcopy(raw)
                for alignment in absent_checks["alignments"]:
                    alignment["matches"] = alignment["matches"][:8]
                job = publish(job, Architecture.model_validate(absent_checks), 2)
                ready = read_scene(job["id"])["guide_readiness"]
                assert ready["ready"] and ready["validation"]["status"] == "missing"
                failed_check = copy.deepcopy(raw)
                failed_check["alignments"][0]["matches"][-1]["image"][0] += 0.05
                job = publish(job, Architecture.model_validate(failed_check), 3)
                value = read_scene(job["id"])
                assert not value["localizable"]
                assert value["guide_readiness"]["validation"]["status"] == "failed"
                assert guidance(store.artifact_dir(job)) is None
                raw_photos = copy.deepcopy(raw)
                raw_photos["alignments"] = []
                job = publish(job, Architecture.model_validate(raw_photos), 4)
                assert read_scene(job["id"])["guide_readiness"]["status"] == "needs_calibration"
                # Genuine calibrated fitting still reports insufficient shared landmarks, not failure.
                few = copy.deepcopy(raw)
                for alignment in few["alignments"]:
                    alignment["matches"] = alignment["matches"][:6]
                job = publish(job, Architecture.model_validate(few), 5)
                assert "eight shared" in " ".join(read_scene(job["id"])["guide_readiness"]["reasons"])
                bad_fit = copy.deepcopy(raw)
                for alignment in bad_fit["alignments"]:
                    for match in alignment["matches"][:4]:
                        match["role"] = "check"
                job = publish(job, Architecture.model_validate(bad_fit), 6)
                value = read_scene(job["id"])
                assert value["calibration_failures"] and not value["guide_readiness"]["ready"]
                assert localize(job["id"], root / "unused.jpg")["status"] == "lost"
                job = store.update_job(job["id"], options={"engine": "architecture"})
                job = publish(job, model, 7)
                assert "calibration is missing" in " ".join(read_scene(job["id"])["guide_readiness"]["reasons"])
                # Failed CAS removes unpublished artifacts and preserves the visible revision.
                before = set((root / "architecture").iterdir())
                try:
                    publish(job, model, 0)
                except ValueError as error:
                    assert str(error).startswith("Revision conflict")
                else:
                    raise AssertionError("Stale publication accepted")
                assert set((root / "architecture").iterdir()) == before
                assert store.get_job(job["id"])["revision"] == 8
                # Exact persisted per-photo calibration works without capture-level settings.
                with patch("app.architecture.landmarks.cv2.SIFT_create", return_value=MockSift([])):
                    job = publish(job, Architecture.model_validate(persisted), 8)
                assert "usable image descriptors" in " ".join(read_scene(job["id"])["guide_readiness"]["reasons"])
                job = publish(job, Architecture.model_validate(persisted), 9)
                current = store.artifact_dir(job)
                current_index = guidance(current)
                assert read_scene(job["id"])["guide_readiness"]["ready"]
                (current / current_index["index_file"]).unlink()
                assert not read_scene(job["id"])["guide_readiness"]["ready"]
                assert localize(job["id"], root / "unused.jpg")["status"] == "lost"
                # Legacy missing-index scenes report requirements without rewriting saved metadata.
                legacy = json.loads((current / "scene.json").read_text())
                legacy.pop("guide_readiness")
                (current / "guidance.json").unlink()
                store.atomic_json(current / "scene.json", legacy)
                assert read_scene(job["id"])["guide_readiness"]["status"] == "needs_calibration"
                assert "guide_readiness" not in json.loads((current / "scene.json").read_text())
                assert all((first / name).read_bytes() == content for name, content in preserved.items())
        finally:
            store.DATA = original
    print("PASS: isolated calibrated publication, withheld checks, insufficient evidence, explicit rebuild and atomic revisions")


if __name__ == "__main__":
    check()

"""Synthetic camera/mock feature evidence only; never reads saved rooms or demo media."""

import io
import itertools
import json
import math
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import HTTPException, UploadFile
from PIL import Image
from pydantic import ValidationError
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import recognition, store
from app.api.recognition import (
    ConnectionRequest, ConnectionWalkthroughRequest, Endpoint,
    connection_endpoints, create_room_connection, recognize_room, route_to_connection,
)
from app.architecture import Architecture
from app.architecture.walkthrough import WalkingProfile, walking_region
from app.localization import load_index

CALIBRATION = {"model": "PINHOLE", "width": 800, "height": 600, "params": [700, 700, 400, 300]}
CENTER = np.array([2., 1.65, 1.])
LOCAL = np.array(list(itertools.product([-1., 0., 1.], [-0.8, 0.8], [3., 4.])))
XYZ = LOCAL + CENTER
PIXELS = LOCAL[:, :2] / LOCAL[:, 2:] * 700 + [400, 300]


def element(identifier, kind, **fields):
    return {"id": identifier, "kind": kind, "label": identifier, "level": "ground",
            "sources": ["00000.jpg"], "evidence": "Synthetic mock geometry only.",
            "color": "#aaaaaa", **fields}


def document():
    return {"title": "Isolated room graph mock", "notes": ["Not observed physical geometry."],
            "levels": [{"id": "ground", "name": "Ground", "elevation": 0}],
            "elements": [
                element("floor", "slab", polygon=[[0, 0], [10, 0], [10, 10], [0, 10]], thickness=0.2),
                element("wall", "wall", start=[0, 0], end=[10, 0], height=3, thickness=0.1,
                        openings=[{"id": "door", "kind": "door", "offset": 1, "width": 2, "height": 2.2, "sill": 0},
                                  {"id": "window", "kind": "window", "offset": 5, "width": 1, "height": 1, "sill": 1}]),
                element("table", "box", position=[5, 0, 1], size=[1, 1, 2]),
            ]}


def make_job(name, descriptor_offset=0, ready=True):
    job = store.create_job(name, {"engine": "architecture", "calibration": CALIBRATION})
    revision = store.uuid4().hex
    root = store.job_dir(job["id"]) / "architecture" / revision
    root.mkdir(parents=True)
    descriptors = np.eye(128, dtype=np.float32)[descriptor_offset:descriptor_offset + len(XYZ)]
    np.savez_compressed(root / "features.npz", descriptors=descriptors, xyz=XYZ,
                        point_ids=np.arange(len(XYZ)), reference_ids=np.zeros(len(XYZ), dtype=np.int32))
    store.atomic_json(root / "guidance.json", {"revision": 1, "artifact_revision": revision,
                                              "index_file": "features.npz", "references": ["00000.jpg"]})
    store.atomic_json(root / "scene.json", {"mode": "architecture", "revision": 1, "artifact_revision": revision,
                                           "localizable": ready, "guide_readiness": {"ready": ready},
                                           "display_from_world": np.eye(4).tolist()})
    store.atomic_json(root / "architecture.json", Architecture.model_validate(document()).model_dump())
    return store.update_job(job["id"], status="ready", revision=1, artifact_revision=revision)


class MockSift:
    """Only feature extraction is mocked; actual FLANN, PnP, depth and coverage checks run."""
    def __init__(self, offset=0, empty=False):
        self.offset, self.empty = offset, empty

    def detectAndCompute(self, gray, mask):
        if self.empty:
            return [], None
        keys = [cv2.KeyPoint(float(x), float(y), 5) for x, y in PIXELS]
        return keys, np.eye(128, dtype=np.float32)[self.offset:self.offset + len(keys)]


def frame():
    output = io.BytesIO()
    Image.new("RGB", (800, 600), "gray").save(output, format="JPEG")
    return UploadFile(filename="mock.jpg", file=io.BytesIO(output.getvalue()))


def detect(offset=0):
    with patch("app.localization.cv2.SIFT_create", return_value=MockSift(offset)):
        return recognize_room(frame(), json.dumps(CALIBRATION), time.time(), None)


def rejects(call, status, phrase=None):
    try:
        call()
    except HTTPException as error:
        assert error.status_code == status, (error.status_code, error.detail)
        if phrase:
            assert phrase in str(error.detail), error.detail
    else:
        raise AssertionError("Expected rejection")


def check():
    original = store.DATA
    with tempfile.TemporaryDirectory() as directory:
        store.DATA = Path(directory)
        try:
            a = make_job("Mock room A", 0)
            b = make_job("Mock room B", 32)
            draft = make_job("Mock uncalibrated room", 64, False)
            a_match = detect()
            assert a_match["status"] == "recognized" and a_match["map_id"] == a["id"]
            assert a_match["searched_count"] == 2 and any(e["map_id"] == draft["id"] for e in a_match["excluded"])
            assert np.allclose(a_match["localization"]["model_position_m"], CENTER, atol=1e-4)
            b_match = detect(32)
            assert b_match["map_id"] == b["id"] and b_match["status"] == "recognized", "Recognition cannot assume the first room"
            assert recognition.room_route(a["id"], b["id"])["status"] == "unknown", "Names never establish topology"
            with patch("app.localization.cv2.SIFT_create", return_value=MockSift(empty=True)):
                unknown = recognize_room(frame(), json.dumps(CALIBRATION), time.time(), None)
            assert unknown["status"] == "unknown" and unknown["map_id"] is None and unknown["localization"] is None
            clone = make_job("Mock visually ambiguous room", 0)
            ambiguous = detect()
            assert ambiguous["status"] == "ambiguous" and ambiguous["map_id"] is None
            store.update_job(clone["id"], status="failed")
            with patch("app.localization.cv2.SIFT_create", return_value=MockSift()):
                subset = recognize_room(frame(), json.dumps(CALIBRATION), time.time(), json.dumps([a["id"]]))
            assert subset["status"] == "incomplete" and subset["map_id"] is None
            rejects(lambda: recognize_room(frame(), None, float("nan"), None), 422)
            rejects(lambda: recognize_room(frame(), None, time.time(), '[1]'), 422)
            ends = connection_endpoints(a["id"])["endpoints"]
            assert len(ends) == 1 and ends[0]["opening_id"] == "door" and ends[0]["floor_ids"] == ["floor"]
            def endpoint(job, match):
                return Endpoint(map_id=job["id"], revision=1, query_id=match["localization"]["query_id"],
                                element_id="wall", opening_id="door", floor_id="floor")
            ea, eb = endpoint(a, a_match), endpoint(b, b_match)
            body = ConnectionRequest(a=ea, b=eb, user_confirmed=True, evidence="User explicitly confirms these exact mock doorway endpoints join.")
            rejects(lambda: create_room_connection(body.model_copy(update={"user_confirmed": False})), 422)
            rejects(lambda: create_room_connection(body.model_copy(update={"b": ea})), 422)
            rejects(lambda: create_room_connection(body.model_copy(update={"a": ea.model_copy(update={"opening_id": "window"})})), 422)
            rejects(lambda: create_room_connection(body.model_copy(update={"a": ea.model_copy(update={"floor_id": "ground"})})), 422)
            rejects(lambda: create_room_connection(body.model_copy(update={"a": ea.model_copy(update={"revision": 2})})), 409)
            link = create_room_connection(body)
            rejects(lambda: create_room_connection(body), 409)
            assert np.allclose(link["a"]["position"], CENTER, atol=1e-4)
            graph = recognition.room_route(a["id"], b["id"])
            assert graph["status"] == "connected" and graph["hops"][0]["from"]["map_id"] == a["id"]
            assert recognition.room_route(b["id"], a["id"])["hops"][0]["to"]["map_id"] == a["id"]
            c = make_job("Mock room C", 64)
            ec = endpoint(c, detect(64))
            create_room_connection(ConnectionRequest(a=eb, b=ec, user_confirmed=True, evidence="Explicit mock B-to-C pair."))
            chain = recognition.room_route(a["id"], c["id"])
            assert chain["status"] == "connected" and len(chain["hops"]) == 2
            assert [hop["to"]["map_id"] for hop in chain["hops"]] == [b["id"], c["id"]]
            request = ConnectionWalkthroughRequest(expected_revision=1, connection_id=link["id"], start=[8, 1])
            route = route_to_connection(a["id"], request)
            model = Architecture.model_validate(document())
            _, _, free, _ = walking_region(model, WalkingProfile(expected_revision=1, floor_id="floor"))
            line = LineString([[p[0], p[2]] for p in route["points"]])
            assert free.buffer(1e-9).covers(line), "No smoothed route segment may cross an obstacle"
            assert len(route["points"]) > 2 and route["distance_m"] > 6.05, "Table requires a detour"
            assert math.isclose(route["distance_m"], line.length, abs_tol=1e-8)
            assert np.allclose(route["points"][-1][::2], CENTER[::2], atol=1e-4)
            assert route["target_id"] == "connection_" + link["id"]
            assert route["transition_map_id"] == b["id"] and route["transition_requires_recognition"] is True
            assert route["physical_position"] == "unknown"
            rejects(lambda: route_to_connection(a["id"], request.model_copy(update={"start": [5, 1]})), 422)
            rejects(lambda: route_to_connection(a["id"], request.model_copy(update={"start": [-1, 1]})), 422)
            rejects(lambda: route_to_connection(a["id"], request.model_copy(update={"expected_revision": 2})), 409)
            rejects(lambda: route_to_connection(a["id"], request.model_copy(update={"start": [8, 3], "radius_m": 1})), 422, "approach")
            for start in ([float("nan"), 1], [float("inf"), 1], [10001, 1]):
                try:
                    ConnectionWalkthroughRequest(expected_revision=1, connection_id=link["id"], start=start)
                except ValidationError:
                    pass
                else:
                    raise AssertionError("Invalid point route start accepted")
            # Retained images may be pruned without deleting an already confirmed durable link.
            photo = store.job_dir(a["id"]) / "queries" / (ea.query_id + ".jpg")
            photo.unlink()
            rejects(lambda: create_room_connection(body), 409, "image")
            assert recognition.room_route(a["id"], b["id"])["status"] == "connected"
            store.update_job(b["id"], revision=2)
            stale = recognition.room_route(a["id"], b["id"])
            assert stale["status"] == "unknown" and stale["excluded"]
            rejects(lambda: route_to_connection(a["id"], request), 422, "stale")
            # Exhaustive bounded search rejects the whole-house claim, rather than truncating to first eight.
            for i in range(8):
                make_job(f"Bounded mock room {i}", 32)
            capped = detect()
            assert capped["status"] == "incomplete" and capped["searched_count"] == 0
        finally:
            load_index.cache_clear()
            store.DATA = original
    print("PASS: isolated multi-room geometric recognition, ambiguity/loss rejection, recorded graph, model-only doorway point routes and stale evidence")


if __name__ == "__main__":
    check()

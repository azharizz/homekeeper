"""Bounded geometric room recognition and explicitly observed room links."""

import json
import time
from collections import deque
from itertools import pairwise
from uuid import uuid4

import numpy as np

from . import store
from .architecture import Architecture
from .architecture.walkthrough import WalkingProfile, surface_route, walking_region
from shapely.geometry import Point, Polygon
import shapely
from .architecture.landmarks import guidance
from .localization import localize

MAX_CANDIDATES = 8


def eligible_space(job):
    if job["status"] != "ready" or job["options"].get("engine") != "architecture":
        return "Space is not a ready calibrated architectural map."
    try:
        root = store.artifact_dir(job)
        scene = json.loads((root / "scene.json").read_text())
        index = guidance(root)
        if (not index or not scene.get("guide_readiness", {}).get("ready")
                or index.get("revision") != job.get("revision")
                or index.get("artifact_revision") != job.get("artifact_revision")
                or scene.get("revision") != job.get("revision")
                or scene.get("artifact_revision") != job.get("artifact_revision")
                or not (root / index["index_file"]).is_file()):
            return "Space lacks a current calibrated localization index."
    except (OSError, ValueError, KeyError):
        return "Space calibration artifacts are missing or unreadable."
    return None


def verified_pose(result, revision):
    position = result.get("model_position_m")
    return (result.get("status") == "localized"
            and result.get("map_revision") == revision
            and isinstance(position, list) and len(position) == 3
            and all(isinstance(v, (int, float)) and np.isfinite(v) and abs(v) <= 10000 for v in position)
            and result.get("inliers", 0) >= 8
            and 0.2 <= result.get("inlier_ratio", 0) <= 1
            and 0.01 <= result.get("image_coverage", 0) <= 1
            and 0 <= result.get("reprojection_error_px", float("nan")) <= 4)


def recognize(path, calibration=None, captured_at=None, candidate_ids=None):
    jobs = store.list_jobs()
    eligible, excluded = [], []
    for job in jobs:
        reason = eligible_space(job)
        if reason:
            excluded.append({"map_id": job["id"], "reason": reason})
        else:
            eligible.append(job)
    selected = [job for job in eligible if candidate_ids is None or job["id"] in candidate_ids]
    omitted = [job["id"] for job in eligible if job not in selected]
    if len(selected) > MAX_CANDIDATES:
        return {"status": "incomplete", "map_id": None, "localization": None,
                "candidates": [], "excluded": excluded,
                "reason": f"More than {MAX_CANDIDATES} calibrated Spaces are eligible; no exhaustive bounded search is possible.",
                "eligible_count": len(eligible), "searched_count": 0}
    candidates, matches, errors = [], [], []
    for job in selected:
        try:
            result = localize(job["id"], path, calibration, captured_at)
            current = store.get_job(job["id"])
            if (current.get("revision") != job.get("revision")
                    or current.get("artifact_revision") != job.get("artifact_revision")
                    or eligible_space(current)):
                raise ValueError("Space revision changed during recognition.")
            valid = verified_pose(result, job.get("revision"))
            candidates.append({"map_id": job["id"], "name": job["name"],
                               "revision": job.get("revision"), "verified": valid,
                               **{key: result.get(key) for key in ("inliers", "inlier_ratio", "image_coverage", "reprojection_error_px", "reason")}})
            if valid:
                matches.append((job, result))
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            errors.append({"map_id": job["id"], "reason": str(error)})
    response = {"map_id": None, "localization": None, "candidates": candidates,
                "excluded": excluded, "errors": errors, "omitted_map_ids": omitted,
                "eligible_count": len(eligible), "searched_count": len(selected)}
    latest = {(job["id"], job.get("revision"), job.get("artifact_revision"))
              for job in store.list_jobs() if not eligible_space(job)}
    snapshot = {(job["id"], job.get("revision"), job.get("artifact_revision")) for job in eligible}
    if latest != snapshot:
        return response | {"status": "incomplete", "reason": "Eligible Spaces changed during recognition. Capture another frame; current room remains unknown."}
    if len(matches) > 1:
        return response | {"status": "ambiguous", "reason": "Multiple Spaces passed geometric verification. Show a distinctive view; current room remains unknown."}
    if errors or omitted:
        return response | {"status": "incomplete", "reason": "Not every eligible Space was verified; a unique current-room match cannot be asserted."}
    if not matches:
        return response | {"status": "unknown", "reason": "No calibrated Space passed geometric verification." if eligible else "No eligible Space has current calibrated localization evidence. Capture overlapping views and publish calibrated landmarks before recognition."}
    job, result = matches[0]
    return response | {"status": "recognized", "map_id": job["id"],
                       "revision": job["revision"], "name": job["name"],
                       "localization": result, "reason": "One Space passed geometric verification; physical position remains unverified."}


def opening_endpoints(job):
    document = json.loads((store.artifact_dir(job) / "architecture.json").read_text())
    return [{"element_id": wall["id"], "opening_id": opening["id"],
             "level_id": wall["level"],
             "floor_ids": [element["id"] for element in document["elements"]
                           if element["kind"] == "slab" and element["level"] == wall["level"]],
             "label": wall["label"], "kind": opening["kind"]}
            for wall in document["elements"] if wall["kind"] == "wall"
            for opening in wall.get("openings", [])
            if opening.get("id") and opening["kind"] in {"door", "passage"}]


def save_connection(a, b, evidence):
    value = {"id": uuid4().hex, "a": a, "b": b, "evidence": evidence,
             "source": "user-confirmed observed endpoint pair", "created_at": time.time(),
             "physically_verified": False, "units": "estimated_metres"}
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("CREATE TABLE IF NOT EXISTS room_connections (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        rows = connection.execute("SELECT payload FROM room_connections").fetchall()
        identity = lambda endpoint: (endpoint["map_id"], endpoint["revision"], endpoint["element_id"], endpoint["opening_id"])
        pair = {identity(a), identity(b)}
        for row in rows:
            previous = json.loads(row[0])
            if {identity(previous["a"]), identity(previous["b"])} == pair:
                raise ValueError("This current doorway pair is already recorded.")
        connection.execute("INSERT INTO room_connections VALUES (?, ?)", (value["id"], json.dumps(value, allow_nan=False)))
    return value


def connections():
    # A read does not create/migrate a table or rewrite saved room artifacts.
    with store.connect() as connection:
        exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_connections'").fetchone()
        rows = connection.execute("SELECT payload FROM room_connections ORDER BY rowid").fetchall() if exists else []
    active, excluded = [], []
    for row in rows:
        value = json.loads(row[0])
        try:
            for endpoint in (value["a"], value["b"]):
                job = store.get_job(endpoint["map_id"])
                if eligible_space(job) or job.get("revision") != endpoint["revision"]:
                    raise ValueError("Endpoint calibration or revision is no longer current.")
                if not any(e["element_id"] == endpoint["element_id"] and e["opening_id"] == endpoint["opening_id"] for e in opening_endpoints(job)):
                    raise ValueError("Recorded opening no longer exists.")
            active.append(value)
        except (ValueError, KeyError, OSError) as error:
            excluded.append({"id": value["id"], "reason": str(error)})
    return {"connections": active, "excluded": excluded}


def room_route(from_map_id, to_map_id):
    links = connections()
    if from_map_id == to_map_id:
        return {"status": "same_room", "hops": [], "excluded": links["excluded"]}
    graph = {}
    for link in links["connections"]:
        for first, second in ((link["a"], link["b"]), (link["b"], link["a"])):
            graph.setdefault(first["map_id"], []).append({"connection_id": link["id"], "from": first, "to": second})
    queue = deque([(from_map_id, [])])
    seen = {from_map_id}
    while queue:
        current, hops = queue.popleft()
        for hop in graph.get(current, []):
            other = hop["to"]["map_id"]
            if other == to_map_id:
                return {"status": "connected", "hops": hops + [hop], "excluded": links["excluded"],
                        "reason": "Recorded user-confirmed room links only; each model approach still requires a fresh within-room route. No common metric transform or physical clearance is established."}
            if other not in seen:
                seen.add(other)
                queue.append((other, hops + [hop]))
    return {"status": "unknown", "hops": [], "excluded": links["excluded"],
            "reason": "No current recorded endpoint-pair path connects these Spaces. Observe and explicitly confirm the missing doorway link; room names do not establish topology."}


def connection_walkthrough(job, body):
    link = next((link for link in connections()["connections"] if link["id"] == body.connection_id), None)
    if not link:
        raise ValueError("This recorded connection is missing or stale. Observe and confirm current endpoints again.")
    endpoint, destination = (link["a"], link["b"]) if link["a"]["map_id"] == job["id"] else (link["b"], link["a"])
    if endpoint["map_id"] != job["id"] or endpoint["revision"] != body.expected_revision:
        raise ValueError("The connection endpoint does not belong to this current Space revision.")
    document = Architecture.model_validate_json((store.artifact_dir(job) / "architecture.json").read_text())
    profile = WalkingProfile(expected_revision=body.expected_revision, floor_id=endpoint["floor_id"],
                             radius_m=body.radius_m, body_height_m=body.body_height_m, eye_height_m=body.eye_height_m)
    floor, height, free, _ = walking_region(document, profile)
    goal = [endpoint["position"][0], endpoint["position"][2]]
    region = next((part for part in shapely.get_parts(free)
                   if isinstance(part, Polygon) and part.covers(Point(body.start))), None)
    if region is None:
        raise ValueError("The current model start is outside the body-clear authored floor area; it has not been moved.")
    if not region.covers(Point(goal)):
        raise ValueError("The recorded doorway observation has no connected body-clear floor approach for this profile; it has not been moved.")
    path, _ = surface_route(region, None, body.start, None, None, None, height + body.eye_height_m, 0, point_goal=goal)
    return {
        "map_id": job["id"], "revision": body.expected_revision, "floor_id": floor.id,
        "target_id": "connection_" + body.connection_id, "target_label": "Recorded doorway observation",
        "target_position": endpoint["position"], "points": [[x, height, z] for x, z in path],
        "distance_m": sum(np.linalg.norm(np.asarray(a) - b) for a, b in pairwise(path)),
        "approach_gap_m": 0, "requested_stop_distance_m": 0, "start_is_automatic": False,
        "profile": profile.model_dump(exclude={"expected_revision", "floor_id"}) | {"stop_distance_m": 0},
        "routing_method": "constrained_floor_triangles", "units": "estimated_metres", "physical_position": "unknown",
        "transition_map_id": destination["map_id"], "transition_requires_recognition": True,
        "limitations": ["Stop at the recorded model camera position; this is not a doorway center or verified physical arrival.",
                        "This route never crosses a doorway. Fresh unique room recognition is required to continue in the next Space.",
                        "Modeled body clearance is not physical clearance. Unknown obstacles, scale errors and unobserved door swings remain unknown."],
    }

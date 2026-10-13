"""Camera-only current-room recognition and explicit doorway-pair evidence."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from shapely.geometry import Point

from .. import recognition, store
from ..architecture import Architecture, Identifier, Number
from ..architecture.walkthrough import WalkingProfile, walking_region
from ..reconstruction import decode_image
from .maps import parse_calibration, query_slot, require_job, retained_observation

router = APIRouter()


@router.post("/api/recognize")
def recognize_room(image: UploadFile = File(...), calibration: str | None = Form(None),
                   captured_at: float | None = Form(None), candidate_ids: str | None = Form(None)):
    camera = parse_calibration(calibration)
    if captured_at is not None and not np.isfinite(captured_at):
        raise HTTPException(422, "Capture time must be finite.")
    selected = None
    if candidate_ids is not None:
        try:
            selected = json.loads(candidate_ids)
            if (not isinstance(selected, list) or not 1 <= len(selected) <= recognition.MAX_CANDIDATES
                    or any(not isinstance(value, str) for value in selected)
                    or len(set(selected)) != len(selected)):
                raise ValueError("Use one to eight distinct map identifiers.")
            for value in selected:
                require_job(value)
        except (ValueError, TypeError) as error:
            raise HTTPException(422, "candidate_ids must be a JSON array of one to eight distinct map identifiers.") from error
    if not query_slot.acquire(blocking=False):
        raise HTTPException(429, "Another frame is being localized. Wait for it to finish.")
    try:
        data = image.file.read(20 * 1024 * 1024 + 1)
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, "Query image exceeds 20 MB.")
        with TemporaryDirectory(prefix="room-recognition-") as directory:
            path = Path(directory) / "frame.jpg"
            path.write_bytes(data)
            decoded, _ = decode_image(path)
            decoded.save(path, quality=95)
            result = recognition.recognize(path, camera, captured_at, selected)
            if result["status"] == "recognized":
                job = require_job(result["map_id"], ready=True)
                if job.get("revision") != result["revision"] or recognition.eligible_space(job):
                    raise HTTPException(409, "Space changed during recognition. Capture another frame.")
                query_id = uuid4().hex
                queries = store.job_dir(job["id"]) / "queries"
                queries.mkdir(exist_ok=True)
                (queries / f"{query_id}.jpg").write_bytes(path.read_bytes())
                store.atomic_json(queries / f"{query_id}.json", {
                    "calibration": camera, "captured_at": captured_at,
                    "result": result["localization"], "source": "multi-room geometric recognition",
                })
                for old in sorted(queries.glob("*.json"), key=lambda p: p.stat().st_mtime)[:-64]:
                    old.with_suffix(".jpg").unlink(missing_ok=True)
                    old.unlink(missing_ok=True)
                result["localization"] = result["localization"] | {"query_id": query_id}
            return result
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    finally:
        image.file.close()
        query_slot.release()


class Endpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    map_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    query_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    element_id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")
    opening_id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")
    floor_id: Identifier


class ConnectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a: Endpoint
    b: Endpoint
    user_confirmed: bool
    evidence: str = Field(min_length=1, max_length=2000)


def validated_endpoint(endpoint):
    job = require_job(endpoint.map_id, ready=True)
    if job.get("revision") != endpoint.revision or recognition.eligible_space(job):
        raise HTTPException(409, "Each endpoint needs the current calibrated Space revision.")
    opening = next((value for value in recognition.opening_endpoints(job)
                    if value["element_id"] == endpoint.element_id and value["opening_id"] == endpoint.opening_id), None)
    if not opening:
        raise HTTPException(422, "Select an existing stable door or passage opening, not a room name or window.")
    if endpoint.floor_id not in opening["floor_ids"]:
        raise HTTPException(422, "Select an authored floor slab on the opening's level.")
    observation = retained_observation(endpoint.map_id, endpoint.query_id)
    result = observation["result"]
    if not recognition.verified_pose(result, endpoint.revision):
        raise HTTPException(409, "Each endpoint needs a retained geometrically verified observation on its current revision.")
    if not (store.job_dir(endpoint.map_id) / "queries" / (endpoint.query_id + ".jpg")).is_file():
        raise HTTPException(409, "The endpoint observation image is no longer retained. Capture another frame.")
    document = Architecture.model_validate_json((store.artifact_dir(job) / "architecture.json").read_text())
    try:
        _, height, free, _ = walking_region(document, WalkingProfile(expected_revision=endpoint.revision, floor_id=endpoint.floor_id))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    position = result["model_position_m"]
    if not free.covers(Point(position[0], position[2])) or not 0.3 <= position[1] - height <= 2.4:
        raise HTTPException(422, "The observed camera position must lie above this body-clear authored floor. It has not been moved or projected to another floor.")
    return endpoint.model_dump() | {"label": opening["label"],
                                   "position": result["model_position_m"],
                                   "captured_at": result.get("captured_at"),
                                   "position_source": "retained localized camera position; not doorway center",
                                   "artifact_revision": job["artifact_revision"]}


@router.get("/api/maps/{job_id}/connection-endpoints")
def connection_endpoints(job_id: str):
    job = require_job(job_id, ready=True)
    if job["options"].get("engine") != "architecture":
        raise HTTPException(409, "Explicit doorway endpoints require an architectural Space.")
    return {"map_id": job_id, "revision": job.get("revision"),
            "endpoints": recognition.opening_endpoints(job),
            "reason": "Authored door/passage references only. An opening alone does not establish a room connection or physical clearance."}


@router.post("/api/room-connections", status_code=201)
def create_room_connection(body: ConnectionRequest):
    if body.user_confirmed is not True or not body.evidence.strip():
        raise HTTPException(422, "Explicit user confirmation and observed endpoint-pair evidence are required.")
    if body.a.map_id == body.b.map_id:
        raise HTTPException(422, "A room connection must join two different Spaces.")
    a, b = validated_endpoint(body.a), validated_endpoint(body.b)
    try:
        return recognition.save_connection(a, b, body.evidence.strip())
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.get("/api/room-connections")
def read_room_connections():
    return recognition.connections()


@router.get("/api/room-route")
def read_room_route(from_map_id: str, to_map_id: str):
    for value in (from_map_id, to_map_id):
        job = require_job(value, ready=True)
        if recognition.eligible_space(job):
            raise HTTPException(409, "Room graph routing requires current calibrated Spaces.")
    return recognition.room_route(from_map_id, to_map_id)


class ConnectionWalkthroughRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    connection_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    start: tuple[Number, Number]
    radius_m: float = Field(default=0.3, ge=0.1, le=1, allow_inf_nan=False)
    body_height_m: float = Field(default=1.8, ge=0.5, le=2.5, allow_inf_nan=False)
    eye_height_m: float = Field(default=1.65, ge=0.3, le=2.4, allow_inf_nan=False)


@router.post("/api/maps/{job_id}/connection-walkthrough")
def route_to_connection(job_id: str, body: ConnectionWalkthroughRequest):
    job = require_job(job_id, ready=True)
    if job.get("revision") != body.expected_revision or recognition.eligible_space(job):
        raise HTTPException(409, "Doorway approach routing needs this current calibrated Space revision.")
    try:
        return recognition.connection_walkthrough(job, body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

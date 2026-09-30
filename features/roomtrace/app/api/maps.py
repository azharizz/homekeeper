"""Capture, reconstruction, localization and scale routes."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import BoundedSemaphore, Lock
from uuid import uuid4

import numpy as np
import pycolmap
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .. import config, store
from ..architecture import Architecture
from ..architecture.landmarks import guidance
from ..architecture.refinement import RefinementRequest
from ..architecture.structure import StructureEdit
from ..localization import load_index, localize
from ..reconstruction import clear_derived, decode_image, reconstruct

router = APIRouter()

# ponytail: one map-building worker per host; use a durable queue only for multi-host service.
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="reconstruction")
query_slot = BoundedSemaphore(1)
retry_lock = Lock()


class Calibration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    width: int = Field(ge=64, le=40000)
    height: int = Field(ge=64, le=40000)
    params: list[float]

    @field_validator("params")
    @classmethod
    def finite_parameters(cls, value):
        if not all(np.isfinite(value)):
            raise ValueError("Camera parameters must be finite.")
        return value


def parse_calibration(value: str | None):
    if not value:
        return None
    try:
        calibration = Calibration.model_validate_json(value).model_dump()
        camera = pycolmap.Camera(
            model=calibration["model"],
            width=calibration["width"],
            height=calibration["height"],
            params=calibration["params"],
        )
        if (
            not camera.verify_params()
            or camera.focal_length_x <= 0
            or camera.focal_length_y <= 0
        ):
            raise ValueError("Invalid camera parameters.")
        return calibration
    except (ValueError, RuntimeError, ValidationError) as error:
        raise HTTPException(
            422,
            "Calibration must contain a supported COLMAP model, width, height, and valid params.",
        ) from error


def require_job(job_id: str, ready=False):
    try:
        job = store.get_job(job_id)
    except (ValueError, KeyError) as error:
        raise HTTPException(404, "Map not found.") from error
    if ready and job["status"] != "ready":
        raise HTTPException(409, "The map is not ready.")
    return job


@router.get("/api/maps")
def maps():
    return store.list_jobs()


@router.post("/api/maps", status_code=202)
async def upload_map(
    files: list[UploadFile] = File(...),
    name: str = Form("Untitled capture"),
    calibration: str | None = Form(None),
    engine: str = Form("architecture"),
):
    if engine not in {"architecture", "mapanything", "colmap"}:
        raise HTTPException(
            422, "Select architecture, mapanything or colmap reconstruction."
        )
    if len(files) in {2, 3}:
        raise HTTPException(
            422,
            "Multi-view captures require 4 to 12 photos. One photo produces an inferred surface.",
        )
    if not 1 <= len(files) <= config.MAX_IMAGES or not 1 <= len(name.strip()) <= 100:
        raise HTTPException(
            422,
            f"Use 1 to {config.MAX_IMAGES} files and a map name of 1 to 100 characters.",
        )
    suffixes = [Path(upload.filename or "").suffix.lower() for upload in files]
    video = any(
        suffix in {".mp4", ".mov", ".webm", ".avi", ".m4v"} for suffix in suffixes
    )
    if video and len(files) != 1:
        raise HTTPException(422, "Upload one video or a set of photos, not both.")
    if not video and any(
        suffix not in {".jpg", ".jpeg", ".png", ".webp"} for suffix in suffixes
    ):
        raise HTTPException(
            422, "Use JPEG, PNG, WebP photos or MP4, MOV, WebM, AVI video."
        )
    if engine == "architecture" and not video and len(files) < 4:
        raise HTTPException(
            422, "Structured architecture requires 4 to 12 photos or one video."
        )
    options = {
        "source": "video" if video else "photos",
        "calibration": parse_calibration(calibration),
        "engine": engine,
    }
    if (
        engine == "mapanything"
        and (video or len(files) > 1)
        and options["calibration"]
        and options["calibration"]["model"] not in {"PINHOLE", "SIMPLE_PINHOLE"}
    ):
        raise HTTPException(
            422,
            "AI reconstruction accepts pinhole calibration. Select COLMAP for calibrated lens distortion.",
        )
    job = store.create_job(name.strip(), options)
    directory = store.job_dir(job["id"])
    uploads = directory / "uploads"
    uploads.mkdir()
    manifest, total = [], 0
    try:
        for index, upload in enumerate(files):
            filename = f"{index:05d}{suffixes[index]}"
            path = uploads / filename
            with path.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    total += len(chunk)
                    if total > config.MAX_UPLOAD:
                        raise HTTPException(
                            413, "Capture exceeds the configured upload limit."
                        )
                    output.write(chunk)
            manifest.append(
                {"stored": filename, "original": Path(upload.filename or filename).name}
            )
        store.atomic_json(directory / "uploads.json", manifest)
    except (HTTPException, OSError) as error:
        store.update_job(
            job["id"],
            status="failed",
            stage="Upload failed",
            error="Upload did not finish. Submit the capture again.",
        )
        raise error
    finally:
        for upload in files:
            await upload.close()
    job = store.update_job(
        job["id"], status="queued", stage="Waiting for reconstruction"
    )
    worker.submit(reconstruct, job["id"])
    return job


@router.get("/api/maps/{job_id}")
def map_status(job_id: str):
    return require_job(job_id)


@router.get("/api/maps/{job_id}/scene")
def scene(job_id: str):
    job = require_job(job_id, ready=True)
    value = json.loads((store.artifact_dir(job) / "scene.json").read_text())
    compact = (
        guidance(store.artifact_dir(job)) if value["mode"] == "architecture" else None
    )
    return value | {
        "scale": job.get("scale"),
        "localizable": bool(compact)
        if value["mode"] == "architecture"
        else value["localizable"],
        "landmark_count": compact["landmark_count"] if compact else 0,
    }


@router.get("/api/maps/{job_id}/artifacts/{filename}")
def artifact(job_id: str, filename: str, revision: str | None = None):
    job = require_job(job_id, ready=True)
    if filename not in {"surface.glb", "points.ply", "scene.json", "architecture.json"}:
        raise HTTPException(404, "Artifact not found.")
    try:
        path = store.artifact_dir(job, revision) / filename
    except ValueError as error:
        raise HTTPException(404, str(error)) from error
    if not path.is_file():
        raise HTTPException(404, "This capture did not produce that artifact.")
    return FileResponse(
        path,
        filename=filename,
        headers={"Cache-Control": "private, max-age=31536000, immutable"}
        if revision
        else None,
    )


@router.get("/api/maps/{job_id}/images/{filename}")
def reference_image(job_id: str, filename: str):
    require_job(job_id)
    path = store.job_dir(job_id) / "images" / filename
    if (
        Path(filename).name != filename
        or not filename.endswith(".jpg")
        or not path.is_file()
    ):
        raise HTTPException(404, "Reference image not found.")
    return FileResponse(path)


@router.post("/api/maps/{job_id}/retry", status_code=202)
def retry(job_id: str):
    with retry_lock:
        job = require_job(job_id)
        if (
            job["status"] not in {"failed", "interrupted"}
            or not (store.job_dir(job_id) / "uploads.json").exists()
        ):
            raise HTTPException(
                409,
                "Only failed or interrupted captures with retained uploads can be retried.",
            )
        clear_derived(store.job_dir(job_id))
        load_index.cache_clear()
        job = store.update_job(
            job_id, status="queued", stage="Waiting to retry", error=None
        )
        worker.submit(reconstruct, job_id)
    return job


@router.post("/api/maps/{job_id}/localize")
def locate(
    job_id: str,
    image: UploadFile = File(...),
    calibration: str | None = Form(None),
    captured_at: float | None = Form(None),
):
    require_job(job_id, ready=True)
    camera = parse_calibration(calibration)
    if captured_at is not None and not np.isfinite(captured_at):
        raise HTTPException(422, "Capture time must be finite.")
    if not query_slot.acquire(blocking=False):
        raise HTTPException(
            429, "Another frame is being localized. Wait for it to finish."
        )
    directory = store.job_dir(job_id) / "queries"
    directory.mkdir(exist_ok=True)
    query_id = uuid4().hex
    path = directory / f"{query_id}.jpg"
    try:
        data = image.file.read(20 * 1024 * 1024 + 1)
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, "Query image exceeds 20 MB.")
        path.write_bytes(data)
        decoded, _ = decode_image(path)
        decoded.save(path, quality=95)
        result = localize(job_id, path, camera, captured_at)
        store.atomic_json(
            directory / f"{query_id}.json",
            {"calibration": camera, "captured_at": captured_at, "result": result},
        )
        # Keep a bounded recent observation history for follow-up agent requests.
        for old in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime)[
            :-64
        ]:
            old.with_suffix(".jpg").unlink(missing_ok=True)
            old.unlink(missing_ok=True)
        return result | {"query_id": query_id}
    except ValueError as error:
        path.unlink(missing_ok=True)
        raise HTTPException(422, str(error)) from error
    finally:
        image.file.close()
        query_slot.release()


def retained_observation(job_id: str, query_id: str):
    require_job(job_id, ready=True)
    directory = store.job_dir(job_id) / "queries"
    if query_id == "latest":
        records = sorted(
            directory.glob("*.json"), key=lambda path: path.stat().st_mtime
        )
        if not records:
            raise HTTPException(
                404, "This map has no retained observation. Capture a frame first."
            )
        query_id = records[-1].stem
    if len(query_id) != 32 or any(c not in "0123456789abcdef" for c in query_id):
        raise HTTPException(404, "Observation not found.")
    path = directory / f"{query_id}.json"
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise HTTPException(
            404, "This observation is no longer retained. Capture another frame."
        ) from error
    return value | {"query_id": query_id}


@router.get("/api/maps/{job_id}/observations/{query_id}")
def inspect_observation(job_id: str, query_id: str):
    return retained_observation(job_id, query_id)


@router.get("/api/maps/{job_id}/observations/{query_id}/image")
def observation_image(job_id: str, query_id: str):
    value = retained_observation(job_id, query_id)
    path = store.job_dir(job_id) / "queries" / (value["query_id"] + ".jpg")
    if not path.is_file():
        raise HTTPException(404, "This observation image is no longer retained.")
    return FileResponse(path)


class ScaleRequest(BaseModel):
    point_a: int = Field(ge=0)
    point_b: int = Field(ge=0)
    distance_m: float = Field(gt=0, le=1000, allow_inf_nan=False)


@router.post("/api/maps/{job_id}/scale")
def calibrate_scale(job_id: str, body: ScaleRequest):
    job = require_job(job_id, ready=True)
    if job["options"].get("engine") == "architecture":
        raise HTTPException(
            409,
            "Architectural dimensions are edited in the scene document, not a point cloud.",
        )
    value = json.loads((store.artifact_dir(job) / "scene.json").read_text())
    points = value["points"]
    if max(body.point_a, body.point_b) >= len(points):
        raise HTTPException(422, "Select two points from this map.")
    distance = float(
        np.linalg.norm(np.array(points[body.point_a]) - points[body.point_b])
    )
    if distance < 1e-8:
        raise HTTPException(422, "Select two distinct points.")
    scale = {
        "meters_per_unit": body.distance_m / distance,
        "point_a": body.point_a,
        "point_b": body.point_b,
        "distance_m": body.distance_m,
        "source": "user-measured distance",
        "updated_at": time.time(),
    }
    store.update_job(job_id, scale=scale)
    return scale


@router.get("/api/maps/{job_id}/capture")
def capture_evidence(job_id: str):
    job = require_job(job_id)
    path = store.job_dir(job_id) / "frames.json"
    if not path.is_file():
        raise HTTPException(409, "Capture frames have not finished decoding.")
    return {
        "job": job,
        "frames": json.loads(path.read_text()),
        "architecture_schema": Architecture.model_json_schema(),
        "refinement_schema": RefinementRequest.model_json_schema(),
        "structure_edit_schema": StructureEdit.model_json_schema(),
        "structure_contract": f"/api/maps/{job_id}/architecture/structure",
        "asset_contract": "/api/assets/schema",
        "material_contract": f"/api/maps/{job_id}/architecture/materials",
        "instructions": "Inspect every source image. Labels are free text, not furniture presets. Use generic primitives when they fit, or create_mesh_asset/import_model_asset for arbitrary static geometry, then publish asset instances. Search only finds saved candidates; inspect their evidence before reuse, never substitute by category. For source-derived surface appearance, read inspect_architecture_materials after the first draft, preview clean photo patches, and publish photo_materials targeting exact geometry IDs. Do not paste whole room photos onto objects or reuse another room's patches. Mark estimated dimensions and contradictory views. Y is up; X/Z is the plan. Levels use absolute elevations. Asset position is its base center; primitive box/solid position is its center. Publish with expected_revision. Do not invent measured scale, camera poses or safe routes.",
    }

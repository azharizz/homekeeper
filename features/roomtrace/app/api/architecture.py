"""Structured architecture editing, evidence, and guidance routes."""

import hashlib
import io
import json

import numpy as np
from PIL import Image, ImageDraw
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from .. import store
from ..architecture import (
    Architecture,
    PhotoAlignment,
    Placement,
    MeasuredDistance,
    ModelDimension,
    measure,
    move_object,
    publish,
    build_mesh,
)
from ..architecture.alignment import fit_photos
from ..architecture.checks import inspect_geometry
from ..architecture.evidence import accuracy_report
from ..architecture.landmarks import guidance
from ..architecture.refinement import (
    RefinementRequest,
    ScaleProposal,
    refine,
    propose_scale,
)
from ..architecture.structure import StructureEdit, structure_report, propose_structure
from ..architecture.walkthrough import (
    WalkingProfile,
    WalkthroughRequest,
    plan_walkthrough,
    walking_area,
)
from ..photo_materials import PhotoMaterial, material_image
from .maps import require_job

router = APIRouter()


@router.get("/api/maps/{job_id}/architecture")
def architecture_document(job_id: str):
    job = require_job(job_id, ready=True)
    if job["options"].get("engine") != "architecture":
        raise HTTPException(409, "This map uses a different reconstruction option.")
    return {
        "revision": job["revision"],
        "document": json.loads(
            (store.artifact_dir(job) / "architecture.json").read_text()
        ),
    }


@router.get("/api/maps/{job_id}/architecture/materials")
def architecture_materials(job_id: str):
    current = architecture_document(job_id)
    document = Architecture.model_validate(current["document"])
    # Inspect geometry even when an old material recipe's source hash needs repair.
    scene = build_mesh(document.model_copy(update={"photo_materials": []}))
    directory = store.job_dir(job_id)
    frames = json.loads((directory / "frames.json").read_text())
    return {
        "revision": current["revision"],
        "schema": PhotoMaterial.model_json_schema(),
        "sources": [
            f
            | {
                "sha256": hashlib.sha256(
                    (directory / "images" / f["name"]).read_bytes()
                ).hexdigest()
            }
            for f in frames
        ],
        "targets": [
            {
                "geometry_id": key,
                "element_id": mesh.metadata["element_id"],
                "material_name": getattr(
                    getattr(mesh.visual, "material", None), "name", None
                ),
                "bounds": mesh.bounds.tolist(),
            }
            for key, mesh in scene.geometry.items()
        ],
        "instructions": "Inspect actual source images and exact mesh-part IDs. Choose clean planar samples of a uniform material, with no furniture edges, occluders, large shadows or specular highlights. Quad order is top-left, top-right, bottom-right, bottom-left. preview_photo_material shows the rectified repeated patch before publication. Add recipes to architecture.photo_materials and publish with expected_revision. Targets are explicit IDs, never label matches. Photo materials replace base color on those parts only. Scale is estimated; lighting remains baked. Mirrored tiling is an authored repetition, not recovered unique pattern placement. Box UV projection follows the object; complex curved seams require a UV-authored GLB via existing asset import. Do not invent normals or measured roughness from RGB. Missing visual evidence should stay explicitly estimated.",
    }


@router.post("/api/maps/{job_id}/architecture/materials/preview")
def preview_material(job_id: str, body: PhotoMaterial):
    require_job(job_id)
    if body.map_id != job_id:
        raise HTTPException(422, "Select a material source from this capture.")
    try:
        picture = material_image(body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    output = io.BytesIO()
    picture.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png")


class ArchitecturePublication(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    document: Architecture


@router.post("/api/maps/{job_id}/architecture")
def publish_architecture(job_id: str, body: ArchitecturePublication):
    job = require_job(job_id)
    if job["options"].get("engine") != "architecture" or job["status"] not in {
        "awaiting_agent",
        "ready",
    }:
        raise HTTPException(409, "Choose a decoded structured architecture capture.")
    if job.get("revision", 0) != body.expected_revision:
        raise HTTPException(
            409, "Revision conflict. Read the current document before editing."
        )
    try:
        return publish(job, body.document, body.expected_revision)
    except ValueError as error:
        raise HTTPException(
            409 if str(error).startswith("Revision conflict") else 422, str(error)
        ) from error


@router.post("/api/maps/{job_id}/architecture/placement")
def place_architecture_object(job_id: str, body: Placement):
    current = architecture_document(job_id)
    if current["revision"] != body.expected_revision:
        raise HTTPException(
            409, "Revision conflict. Read the current document before editing."
        )
    try:
        updated = move_object(Architecture.model_validate(current["document"]), body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return publish_architecture(
        job_id,
        ArchitecturePublication(
            expected_revision=body.expected_revision, document=updated
        ),
    )


@router.get("/api/maps/{job_id}/architecture/measure")
def measure_architecture(job_id: str, first: str, second: str):
    current = architecture_document(job_id)
    try:
        result = measure(
            Architecture.model_validate(current["document"]), first, second
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return result | {"revision": current["revision"]}


@router.get("/api/maps/{job_id}/architecture/checks")
def architecture_checks(job_id: str):
    current = architecture_document(job_id)
    return inspect_geometry(Architecture.model_validate(current["document"])) | {
        "revision": current["revision"]
    }


@router.get("/api/maps/{job_id}/architecture/structure")
def architecture_structure(job_id: str):
    current = architecture_document(job_id)
    return structure_report(Architecture.model_validate(current["document"])) | {
        "revision": current["revision"],
        "edit_schema": StructureEdit.model_json_schema(),
    }


@router.post("/api/maps/{job_id}/architecture/structure-proposal")
def architecture_structure_proposal(job_id: str, body: StructureEdit):
    document = revision_document(job_id, body.expected_revision)
    try:
        return propose_structure(document, body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post("/api/maps/{job_id}/architecture/walkthrough-area")
def architecture_walking_area(job_id: str, body: WalkingProfile):
    document = revision_document(job_id, body.expected_revision)
    try:
        return walking_area(document, body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post("/api/maps/{job_id}/architecture/walkthrough")
def architecture_walkthrough(job_id: str, body: WalkthroughRequest):
    document = revision_document(job_id, body.expected_revision)
    try:
        return plan_walkthrough(document, body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


class DimensionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    dimension: ModelDimension


@router.post("/api/maps/{job_id}/architecture/dimensions")
def add_architecture_dimension(job_id: str, body: DimensionRequest):
    document = revision_document(job_id, body.expected_revision)
    document.dimensions.append(body.dimension)
    try:
        document = Architecture.model_validate(document.model_dump())
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return publish_architecture(
        job_id,
        ArchitecturePublication(
            expected_revision=body.expected_revision, document=document
        ),
    )


@router.get("/api/maps/{job_id}/architecture/accuracy")
def architecture_accuracy(job_id: str):
    job = require_job(job_id, ready=True)
    if job["options"].get("engine") != "architecture":
        raise HTTPException(409, "This map uses a different reconstruction option.")
    # One immutable snapshot keeps measurements, fits and byte counts on the same revision.
    directory = store.artifact_dir(job)
    saved = json.loads((directory / "scene.json").read_text())
    document = Architecture.model_validate(saved["architecture"])
    return accuracy_report(document, saved["photo_alignments"]) | {
        "revision": job["revision"],
        "surface_bytes": (directory / "surface.glb").stat().st_size,
        "surface_triangles": saved["surface_triangles"],
        "source_views": saved["total_frames"],
    }


class AlignmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    alignment: PhotoAlignment
    save: bool = False


def revision_document(job_id, expected):
    current = architecture_document(job_id)
    if current["revision"] != expected:
        raise HTTPException(
            409, "Revision conflict. Read the current document before editing."
        )
    return Architecture.model_validate(current["document"])


@router.post("/api/maps/{job_id}/architecture/refine")
def refine_architecture(job_id: str, body: RefinementRequest):
    document = revision_document(job_id, body.expected_revision)
    frames = json.loads((store.job_dir(job_id) / "frames.json").read_text())
    try:
        return refine(document, frames, body) | {"revision": body.expected_revision}
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post("/api/maps/{job_id}/architecture/scale-proposal")
def architecture_scale_proposal(job_id: str, body: ScaleProposal):
    document = revision_document(job_id, body.expected_revision)
    try:
        return propose_scale(document, body.measurement_ids) | {
            "revision": body.expected_revision
        }
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


class MeasurementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    measurement: MeasuredDistance


@router.post("/api/maps/{job_id}/architecture/measurements")
def add_architecture_measurement(job_id: str, body: MeasurementRequest):
    document = revision_document(job_id, body.expected_revision)
    if any(m.id == body.measurement.id for m in document.measurements):
        raise HTTPException(
            409,
            "Measurement ID already exists. Edit through the full document to preserve provenance.",
        )
    document.measurements.append(body.measurement)
    try:
        document = Architecture.model_validate(document.model_dump())
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return publish_architecture(
        job_id,
        ArchitecturePublication(
            expected_revision=body.expected_revision, document=document
        ),
    )


class LandmarkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    max_error_px: float = Field(default=4, gt=0, le=20, allow_inf_nan=False)


@router.post("/api/maps/{job_id}/architecture/landmarks")
def create_architecture_landmarks(job_id: str, body: LandmarkRequest):
    job = require_job(job_id, ready=True)
    if job["revision"] != body.expected_revision:
        raise HTTPException(409, "Revision changed. Read the current model.")
    document = revision_document(job_id, body.expected_revision)
    try:
        updated = publish(
            job, document, body.expected_revision, max_error_px=body.max_error_px
        )
    except ValueError as error:
        raise HTTPException(
            409 if str(error).startswith("Revision conflict") else 422, str(error)
        ) from error
    directory = store.artifact_dir(updated)
    scene = json.loads((directory / "scene.json").read_text())
    result = guidance(directory) or {
        "revision": updated["revision"],
        "artifact_revision": updated["artifact_revision"],
    }
    return {
        k: v for k, v in result.items() if k not in {"geometry", "landmarks"}
    } | {"guide_readiness": scene["guide_readiness"]}


@router.get("/api/maps/{job_id}/architecture/guidance")
def architecture_guidance(job_id: str):
    job = require_job(job_id, ready=True)
    value = guidance(store.artifact_dir(job))
    if value is None:
        scene = json.loads((store.artifact_dir(job) / "scene.json").read_text())
        reasons = scene.get("guide_readiness", {}).get("reasons", [])
        raise HTTPException(
            409, " ".join(reasons) or "This revision needs observed landmarks and exact source lens calibration."
        )
    return value


class OverlayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    source: str
    document: Architecture | None = None


@router.post("/api/maps/{job_id}/architecture/overlay")
def architecture_overlay(job_id: str, body: OverlayRequest):
    current = revision_document(job_id, body.expected_revision)
    frames = json.loads((store.job_dir(job_id) / "frames.json").read_text())
    try:
        fits = fit_photos(
            body.document or current, frames,
            require_job(job_id)["options"].get("calibration"),
        )
        fit = next((f for f in fits if f["source"] == body.source), None)
        if fit is None:
            raise ValueError("Select a source image with declared alignment landmarks.")
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    with Image.open(store.job_dir(job_id) / "images" / fit["source"]) as original:
        picture = original.convert("RGB")
    draw = ImageDraw.Draw(picture)
    for i, m in enumerate(fit["matches"]):
        observed = tuple(np.array(m["image"]) * fit["size"])
        projected = tuple(np.array(m["projected"]) * fit["size"])
        draw.line([observed, projected], fill="#ffb454", width=3)
        for point, color in (
            (observed, "#c69fff" if m["role"] == "check" else "#00beff"),
            (projected, "#ffb454"),
        ):
            x, y = point
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color, outline="white")
        draw.text(
            (observed[0] + 8, observed[1] + 8),
            f"{i + 1} {m['role']} {m['error_px']:.1f}px",
            fill="white",
            stroke_width=1,
            stroke_fill="black",
        )
    output = io.BytesIO()
    picture.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png")


@router.post("/api/maps/{job_id}/architecture/alignment")
def align_architecture_photo(job_id: str, body: AlignmentRequest):
    current = architecture_document(job_id)
    if current["revision"] != body.expected_revision:
        raise HTTPException(
            409, "Revision conflict. Read the current document before editing."
        )
    updated = current["document"]
    updated["alignments"] = [
        a for a in updated.get("alignments", []) if a["source"] != body.alignment.source
    ] + [body.alignment.model_dump()]
    try:
        document = Architecture.model_validate(updated)
        frames = json.loads((store.job_dir(job_id) / "frames.json").read_text())
        fits = fit_photos(
            document, frames, require_job(job_id)["options"].get("calibration")
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    result = next(fit for fit in fits if fit["source"] == body.alignment.source)
    revision = current["revision"]
    if body.save:
        job = publish_architecture(
            job_id,
            ArchitecturePublication(expected_revision=revision, document=document),
        )
        revision = job["revision"]
    return {"revision": revision, "saved": body.save, "fit": result}

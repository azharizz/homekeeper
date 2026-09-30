"""Explicit geometry proposals. Agents select evidence; numerical tools estimate updates."""

from typing import Literal

import cv2
import numpy as np
from pydantic import Field, model_validator
from scipy.optimize import least_squares

from . import Architecture, Identifier, Number, Record
from .alignment import camera_model, fit_photos, world_points
from .checks import inspect_geometry
from .evidence import measurement_checks


class GeometryParameter(Record):
    element_id: Identifier
    field: Literal[
        "position",
        "size",
        "start",
        "end",
        "height",
        "thickness",
        "bottom",
        "top",
        "width",
        "scale",
        "yaw",
        "pitch",
        "roll",
    ]
    axis: int | None = Field(default=None, ge=0, le=2)
    minimum: Number
    maximum: Number

    @model_validator(mode="after")
    def ordered(self):
        if self.minimum >= self.maximum:
            raise ValueError("Parameter bounds must have positive width.")
        return self


class RefinementRequest(Record):
    expected_revision: int = Field(ge=1)
    parameters: list[GeometryParameter] = Field(min_length=1, max_length=32)
    measurement_ids: list[Identifier] = Field(default_factory=list, max_length=100)


class ScaleProposal(Record):
    expected_revision: int = Field(ge=1)
    measurement_ids: list[Identifier] = Field(min_length=1, max_length=100)


def selected_measurements(document, ids):
    by_id = {m.id: m for m in document.measurements}
    if len(set(ids)) != len(ids) or not set(ids) <= by_id.keys():
        raise ValueError("Select distinct existing physical measurement IDs.")
    return [by_id[i] for i in ids]


def refine(document, frames, request):
    if len(document.alignments) < 2:
        raise ValueError(
            "Joint correction needs landmarks in at least two source photographs."
        )
    before = fit_photos(document, frames)
    working = document.model_copy(deep=True)
    elements = {e.id: e for e in working.elements}
    measurements = selected_measurements(document, request.measurement_ids)
    if len({(p.element_id, p.field, p.axis) for p in request.parameters}) != len(
        request.parameters
    ):
        raise ValueError("Select each geometry parameter only once.")
    values = []
    for p in request.parameters:
        element = elements.get(p.element_id)
        if element is None or not hasattr(element, p.field):
            raise ValueError("Parameter does not exist on the selected element.")
        value = getattr(element, p.field)
        if isinstance(value, tuple):
            if p.axis is None or p.axis >= len(value):
                raise ValueError("Vector parameters require a valid axis.")
            value = value[p.axis]
        elif p.axis is not None:
            raise ValueError("Scalar parameters cannot have an axis.")
        if not p.minimum < value < p.maximum:
            raise ValueError(
                "Current parameter must be strictly within its proposed bounds."
            )
        if (
            p.field in {"size", "height", "thickness", "width", "scale"}
            and p.minimum <= 0
        ):
            raise ValueError("Dimension bounds must stay positive.")
        values.append(value)
    geometry_count = len(values)
    for fit in before:
        pose = np.array(fit["world_to_camera"])
        values.extend(cv2.Rodrigues(pose[:3, :3])[0].ravel())
        values.extend(pose[:3, 3])
    lower = [p.minimum for p in request.parameters] + [-np.inf] * (
        len(values) - geometry_count
    )
    upper = [p.maximum for p in request.parameters] + [np.inf] * (
        len(values) - geometry_count
    )
    observations = []
    for a, f in zip(document.alignments, before):
        matches = [m for m in a.matches if m.role == "fit"]
        k, d = camera_model(a, f["size"])
        observations.append(
            (matches, np.array([m.image for m in matches]) * f["size"], k, d)
        )

    def assign(vector):
        for p, value in zip(request.parameters, vector):
            element = elements[p.element_id]
            if p.axis is None:
                setattr(element, p.field, float(value))
            else:
                data = list(getattr(element, p.field))
                data[p.axis] = float(value)
                setattr(element, p.field, tuple(data))

    def residual(vector):
        assign(vector)
        errors = []
        for i, (matches, pixels, k, d) in enumerate(observations):
            pose = vector[geometry_count + i * 6 : geometry_count + (i + 1) * 6]
            projected = cv2.projectPoints(
                world_points(working, matches), pose[:3], pose[3:], k, d
            )[0].reshape(-1, 2)
            errors.extend((projected - pixels).ravel())
        for m in measurements:
            points = world_points(working, [m.start, m.end])
            errors.append(
                (np.linalg.norm(points[0] - points[1]) - m.distance_m) / m.uncertainty_m
            )
        return np.asarray(errors)

    initial = residual(np.array(values))
    if len(initial) < len(values):
        raise ValueError(
            "Too few fitting observations for these geometry and camera parameters. Keep more geometry fixed."
        )
    result = least_squares(
        residual, values, bounds=(lower, upper), x_scale="jac", max_nfev=250
    )
    assign(result.x)
    proposed = Architecture.model_validate(working.model_dump())
    after = fit_photos(proposed, frames)
    norms = np.linalg.norm(result.jac, axis=0)
    singular = np.linalg.svd(result.jac / np.maximum(norms, 1e-12), compute_uv=False)
    rank = int((singular > singular[0] * 1e-7).sum())
    return {
        "document": proposed.model_dump(),
        "before": before,
        "after": after,
        "measurements_before": measurement_checks(document),
        "measurements_after": measurement_checks(proposed),
        "geometry_checks": inspect_geometry(proposed),
        "parameters": [
            p.model_dump() | {"before": float(a), "after": float(b)}
            for p, a, b in zip(request.parameters, values, result.x)
        ],
        "solver": {
            "converged": bool(result.success),
            "message": result.message,
            "evaluations": result.nfev,
            "rank": rank,
            "variables": len(values),
            "locally_observable": rank == len(values),
            "initial_cost": float(initial @ initial / 2),
            "final_cost": float(result.cost),
            "active_bounds": result.active_mask[:geometry_count].tolist(),
        },
        "saved": False,
        "units": "estimated_metres",
        "limits": "Preview only. Check observations were excluded. Inspect all overlays and geometric checks before publishing this document with the expected revision. Local rank and reprojection error do not establish physical accuracy.",
    }


def scale_document(document, factor):
    """Uniformly scale authored coordinates, including host-local offsets, never evidence lengths."""
    value = document.model_dump()
    for material in value["photo_materials"]:
        material["repeat_m"] = [length * factor for length in material["repeat_m"]]
    for level in value["levels"]:
        level["elevation"] *= factor
    vectors = {"position", "size", "start", "end"}
    lengths = {
        "height",
        "thickness",
        "bottom",
        "top",
        "width",
        "scale",
        "radius",
        "tread_thickness",
        "texture_scale",
    }
    for e in value["elements"]:
        for flight in e.get("flights", []):
            for key in ("start", "end"):
                flight[key] = [n * factor for n in flight[key]]
            for key in ("rise", "width"):
                flight[key] *= factor
            if flight.get("opening"):
                flight["opening"]["margin"] *= factor
        for landing in e.get("landings", []):
            landing["polygon"] = [[n * factor for n in p] for p in landing["polygon"]]
            landing["thickness"] *= factor
        for key in vectors & e.keys():
            e[key] = [n * factor for n in e[key]]
        for key in lengths & e.keys():
            e[key] *= factor
        if "polygon" in e:
            e["polygon"] = [[n * factor for n in p] for p in e["polygon"]]
        if "holes" in e:
            e["holes"] = [
                [[n * factor for n in p] for p in ring] for ring in e["holes"]
            ]
        for o in e.get("openings", []):
            for key in ("offset", "width", "sill", "height"):
                o[key] *= factor
        if e.get("opening"):
            for key in ("margin",):
                if key in e["opening"]:
                    e["opening"][key] *= factor
    return Architecture.model_validate(value)


def propose_scale(document, ids):
    selected_measurements(document, ids)
    checks = measurement_checks(document)
    fitting = [m for m in checks if m["id"] in ids]
    numerator = sum(
        m["model_distance_m"] * m["distance_m"] / m["uncertainty_m"] ** 2
        for m in fitting
    )
    denominator = sum(
        (m["model_distance_m"] / m["uncertainty_m"]) ** 2 for m in fitting
    )
    factor = numerator / denominator
    proposed = scale_document(document, factor)
    return {
        "document": proposed.model_dump(),
        "scale_factor": factor,
        "measurement_ids": ids,
        "before": checks,
        "after": measurement_checks(proposed),
        "saved": False,
        "physically_verified": False,
        "limits": "Weighted uniform scale from reported measurements. Other distances remain estimated. Measurements not selected are independent checks, not fitting inputs.",
    }

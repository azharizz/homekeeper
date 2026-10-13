"""Observed COLMAP tracks, reported scale, and checked model-frame registration."""

import json
from uuid import uuid4

import numpy as np
import pycolmap
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import store


class ScaleReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_a: str = Field(pattern=r"^\d{5}\.jpg$")
    source_b: str = Field(pattern=r"^\d{5}\.jpg$")
    pixels_a: tuple[tuple[float, float], tuple[float, float]]
    pixels_b: tuple[tuple[float, float], tuple[float, float]]
    distance_m: float = Field(gt=0, le=1000, allow_inf_nan=False)
    uncertainty_m: float = Field(gt=0, allow_inf_nan=False)
    provenance: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def validate_evidence(self):
        pixels = np.asarray([self.pixels_a, self.pixels_b])
        if not np.isfinite(pixels).all() or (pixels < 0).any() or (pixels > 1).any():
            raise ValueError("Reference pixels must be finite normalized coordinates in [0, 1].")
        if self.source_a == self.source_b or any(a == b for a, b in (self.pixels_a, self.pixels_b)):
            raise ValueError("Use two distinct endpoints observed in two distinct source views.")
        if self.uncertainty_m >= self.distance_m or not self.provenance.strip():
            raise ValueError("Supply measurement provenance and uncertainty smaller than the distance.")
        return self


def tracked_point(reconstruction, source, pixel, max_error_px):
    image = next((im for im in reconstruction.images.values() if im.has_pose and im.name == source), None)
    if image is None:
        raise ValueError(f"{source} has no reconstructed camera.")
    camera = reconstruction.cameras[image.camera_id]
    uv = np.asarray(pixel) * [camera.width, camera.height]
    candidates = [p for p in image.points2D if p.has_point3D() and np.linalg.norm(p.xy - uv) <= max_error_px]
    if len(candidates) != 1:
        raise ValueError(f"{source}: reference pixel needs one unambiguous triangulated feature within {max_error_px:g}px; found {len(candidates)}.")
    return candidates[0].point3D_id


def measured_scale(reconstruction, reference, max_error_px=4.0):
    reference = ScaleReference.model_validate(reference)
    first = [tracked_point(reconstruction, reference.source_a, p, max_error_px) for p in reference.pixels_a]
    second = [tracked_point(reconstruction, reference.source_b, p, max_error_px) for p in reference.pixels_b]
    if first != second or first[0] == first[1]:
        raise ValueError("Measured endpoints must identify the same two distinct triangulated tracks in both source views.")
    distance = float(np.linalg.norm(reconstruction.points3D[first[0]].xyz - reconstruction.points3D[first[1]].xyz))
    if not np.isfinite(distance) or distance <= 1e-8:
        raise ValueError("Measured endpoints have no usable reconstructed separation.")
    return reference.model_dump() | {
        "point_ids": first, "map_distance": distance,
        "meters_per_unit": reference.distance_m / distance,
        "relative_reported_uncertainty": reference.uncertainty_m / reference.distance_m,
        "source": "user-reported measured distance on cross-view triangulated tracks",
        "physically_verified": False,
        "limits": "Reported distance, not an independent survey. Triangulation uncertainty is not included in the reported measurement uncertainty.",
    }


def capture_report(directory, reconstruction, components, options):
    cameras = {}
    for image in reconstruction.images.values():
        if not image.has_pose:
            continue
        camera = reconstruction.cameras[image.camera_id]
        cameras[image.name] = {
            "model": camera.model_name, "width": camera.width, "height": camera.height,
            "params": camera.params.tolist(),
            "world_to_camera": image.cam_from_world().matrix().tolist(),
            "provenance": "Supplied capture intrinsics; COLMAP pose/track reconstruction" if options.get("calibration") else "COLMAP bundle-adjusted lens estimate from observed multi-view feature tracks; not laboratory calibration",
        }
    supported = sorted(
        (key for key, point in reconstruction.points3D.items() if point.track.length() >= 2 and point.error <= 4.0),
        key=lambda key: (-reconstruction.points3D[key].track.length(), reconstruction.points3D[key].error, key),
    )
    tracks = {key: {
        "point_id": key, "reconstruction_xyz": reconstruction.points3D[key].xyz.tolist(),
        "reprojection_error_px": reconstruction.points3D[key].error, "observations": [],
    } for key in supported[:128]}
    for image in reconstruction.images.values():
        if not image.has_pose:
            continue
        camera = reconstruction.cameras[image.camera_id]
        for point in image.points2D:
            if point.has_point3D() and point.point3D_id in tracks:
                tracks[point.point3D_id]["observations"].append({
                    "source": image.name, "image": (point.xy / [camera.width, camera.height]).tolist(),
                })
    report = {
        "status": "reconstructed", "registered_frames": reconstruction.num_reg_images(),
        "sparse_points": reconstruction.num_points3D(), "components": components,
        "reprojection_error_px": reconstruction.compute_mean_reprojection_error(),
        "cameras": cameras, "scale": None, "scale_failure": None,
        "track_preview": list(tracks.values()), "track_preview_limit": 128,
        "supported_track_count": len(supported),
        "limits": "Tracks and cameras are in an arbitrary COLMAP frame. Authored geometry requires observed anchor registration with held-out checks; raw features do not identify walls, furniture, obstacles or room connections.",
    }
    if options.get("scale_reference"):
        try:
            report["scale"] = measured_scale(reconstruction, options["scale_reference"])
        except ValueError as error:
            report["scale_failure"] = str(error)
    store.atomic_json(directory / "capture_reconstruction.json", report)
    return report


def read_report(directory):
    path = directory / "capture_reconstruction.json"
    return json.loads(path.read_text()) if path.is_file() else None


def similarity(source, target):
    a, b = source.mean(axis=0), target.mean(axis=0)
    x, y = source - a, target - b
    if np.linalg.matrix_rank(x, tol=1e-7) < 3 or np.linalg.matrix_rank(y, tol=1e-7) < 3:
        raise ValueError("Model registration needs non-coplanar fitting anchors.")
    u, singular, vt = np.linalg.svd(y.T @ x)
    sign = np.ones(3)
    sign[-1] = np.linalg.det(u @ vt)
    rotation = (u * sign) @ vt
    scale = float(singular @ sign / np.sum(x * x))
    if not np.isfinite(scale) or scale <= 1e-8:
        raise ValueError("Model registration has no positive finite similarity scale.")
    return scale, rotation, b - scale * rotation @ a


def registered_index(job, target, scene, max_error_px):
    """Never infer a geometry association from image appearance or nearest mesh surfaces."""
    from .architecture import Architecture
    from .architecture.features import resolve_anchor
    from .localization import normalized

    root = store.job_dir(job["id"])
    report = read_report(root)
    if not report or report.get("status") != "reconstructed":
        raise ValueError((report or {}).get("reason", "No reconstructed capture tracks. Capture translated overlapping textured views."))
    reconstruction = pycolmap.Reconstruction(root / "sparse")
    document = Architecture.model_validate(scene["architecture"])
    observations = {}
    anchor_tracks = {}
    for alignment in document.alignments:
        for match in alignment.matches:
            identifier = tracked_point(reconstruction, alignment.source, match.image, max_error_px)
            world = resolve_anchor(document, match)
            anchor = (match.element_id, json.dumps(match.feature.model_dump() if match.feature else match.anchor, sort_keys=True))
            if anchor in anchor_tracks and anchor_tracks[anchor] != identifier:
                raise ValueError("An observed model anchor maps to different reconstructed tracks across views.")
            anchor_tracks[anchor] = identifier
            previous = observations.get(identifier)
            if previous and not np.allclose(previous["world"], world, atol=1e-7):
                raise ValueError("A reconstructed track was assigned to different model anchors.")
            row = observations.setdefault(identifier, {"world": world, "role": "fit", "views": []})
            if match.role == "check":
                row["role"] = "check"  # Hold out the entire track, never just one observation.
            row["views"].append((alignment.source, match.image))
    fitting = [key for key, row in observations.items() if row["role"] == "fit"]
    checks = [key for key, row in observations.items() if row["role"] == "check"]
    if len(fitting) < 4 or len(checks) < 2:
        raise ValueError("Automatic track-to-model registration needs at least four distinct non-coplanar observed fitting anchors and two distinct held-out check anchors. Raw photos alone cannot associate authored geometry.")
    source = np.array([reconstruction.points3D[key].xyz for key in fitting])
    model = np.array([observations[key]["world"] for key in fitting])
    scale, rotation, translation = similarity(source, model)
    span = float(np.linalg.norm(np.ptp(model, axis=0)))
    errors, residuals = [], []
    images = {image.name: image for image in reconstruction.images.values() if image.has_pose}
    for key, row in observations.items():
        recovered = scale * rotation @ reconstruction.points3D[key].xyz + translation
        residuals.append(float(np.linalg.norm(recovered - row["world"]) / max(span, 1e-8)))
        original = rotation.T @ (row["world"] - translation) / scale
        for name, pixel in row["views"]:
            image = images[name]
            camera = reconstruction.cameras[image.camera_id]
            pose = image.cam_from_world().matrix()
            point = pose[:3, :3] @ original + pose[:3, 3]
            if point[2] <= 0:
                raise ValueError("Registered model anchor lies behind its observed camera.")
            error = float(np.linalg.norm(camera.img_from_cam(point.reshape(1, 3))[0] - np.asarray(pixel) * [camera.width, camera.height]))
            errors.append({"source": name, "role": row["role"], "error_px": error})
    if max(residuals) > 0.02 or max(row["error_px"] for row in errors) > max_error_px:
        raise ValueError("Observed track-to-model similarity fails registration checks (2% anchor-span residual or selected pixel threshold). Correct geometry/correspondences; no index published.")
    ids = {key for key, point in reconstruction.points3D.items() if point.track.length() >= 2 and point.error <= max_error_px} - set(checks)
    if len(ids) < 8:
        raise ValueError("Fewer than eight supported multi-view tracks remain after held-out checks.")
    xyz = np.array([scale * rotation @ reconstruction.points3D[key].xyz + translation for key in ids])
    if np.linalg.matrix_rank(xyz - xyz.mean(axis=0), tol=1e-7) < 3:
        raise ValueError("Reconstructed index tracks lack depth variation.")
    descriptors, points, point_ids, reference_ids, references = [], [], [], [], []
    with pycolmap.Database.open(root / "database.db") as database:
        for image in sorted(images.values(), key=lambda im: im.name):
            selected = [i for i, point in enumerate(image.points2D) if point.has_point3D() and point.point3D_id in ids]
            if not selected:
                continue
            desc = database.read_descriptors(image.image_id).to_float().data
            descriptors.append(normalized(desc[selected]))
            for i in selected:
                key = image.points2D[i].point3D_id
                points.append(scale * rotation @ reconstruction.points3D[key].xyz + translation)
                point_ids.append(key)
                reference_ids.append(len(references))
            references.append(image.name)
    if len(set(point_ids)) < 8:
        raise ValueError("Reconstructed tracks have insufficient stored descriptors.")
    filename = f"landmarks-sfm-{uuid4().hex}.npz"
    np.savez_compressed(target / filename, descriptors=np.concatenate(descriptors), xyz=np.array(points),
                        point_ids=np.array(point_ids, dtype=np.int64), reference_ids=np.array(reference_ids, dtype=np.int32))
    validation = {
        "status": "passed", "check_count": len(checks), "threshold_px": max_error_px,
        "max_error_px": max(row["error_px"] for row in errors if row["role"] == "check"),
        "max_relative_3d_residual": max(residuals), "relative_3d_threshold": 0.02,
        "sources": errors, "limits": "Held-out tracks verify frame registration, not physical scale, live localization or safe clearance.",
    }
    registration = {"scale": scale, "rotation": rotation.tolist(), "translation": translation.tolist(),
                    "fit_track_count": len(fitting), "check_track_count": len(checks), "validation": validation}
    scene["capture_registration"] = registration
    scene["reported_scale"] = report.get("scale")
    if report.get("scale"):
        scene["reported_scale"] = report["scale"] | {"meters_per_model_unit": report["scale"]["meters_per_unit"] / scale}
    return {"filename": filename, "ids": point_ids, "references": references, "evidence": [], "registration": registration}

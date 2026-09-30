"""Camera projection from observed photo landmarks. Checks never enter fitting."""

import math

import cv2
import numpy as np

from .features import resolve_anchor


def world_points(document, matches):
    return np.array(
        [resolve_anchor(document, m) for m in matches],
        dtype=np.float64,
    )


def camera_model(alignment, size):
    width, height = size
    c = alignment.calibration
    if c:
        sx, sy = width / c.width, height / c.height
        return np.array(
            [[c.fx * sx, 0, c.cx * sx], [0, c.fy * sy, c.cy * sy], [0, 0, 1.0]]
        ), np.array(c.distortion, dtype=np.float64)
    focal = height / (2 * math.tan(math.radians(alignment.fov_y) / 2))
    return np.array(
        [[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.0]]
    ), np.zeros(5)


def projection_report(document, alignment, size, rotation, translation):
    world = world_points(document, alignment.matches)
    pixels = np.array([m.image for m in alignment.matches]) * size
    fitting = np.array([m.role == "fit" for m in alignment.matches])
    intrinsic, distortion = camera_model(alignment, size)
    world_to_camera = np.eye(4)
    world_to_camera[:3, :3] = cv2.Rodrigues(rotation)[0]
    world_to_camera[:3, 3] = translation.ravel()
    depths = (world @ world_to_camera[:3, :3].T + translation.ravel())[:, 2]
    if not np.isfinite(world_to_camera).all() or (depths <= 0).any():
        raise ValueError(
            "Camera fit places a landmark behind the camera. Check the correspondences."
        )
    projected = cv2.projectPoints(world, rotation, translation, intrinsic, distortion)[
        0
    ].reshape(-1, 2)
    errors = np.linalg.norm(projected - pixels, axis=1)
    return {
        "source": alignment.source,
        "size": list(size),
        "fov_y": alignment.fov_y,
        "intrinsic": intrinsic.tolist(),
        "distortion": distortion.tolist(),
        "calibration_source": alignment.calibration.provenance
        if alignment.calibration
        else "Estimated centered pinhole lens",
        "camera_to_world": (
            np.linalg.inv(world_to_camera) @ np.diag([1, -1, -1, 1])
        ).tolist(),
        "world_to_camera": world_to_camera.tolist(),
        "rmse_px": float(np.sqrt(np.mean(errors[fitting] ** 2))),
        "max_error_px": float(errors[fitting].max()),
        "fit_count": int(fitting.sum()),
        "check_count": int((~fitting).sum()),
        "check_rmse_px": float(np.sqrt(np.mean(errors[~fitting] ** 2)))
        if (~fitting).any()
        else None,
        "check_max_error_px": float(errors[~fitting].max())
        if (~fitting).any()
        else None,
        "planar": bool(
            np.linalg.matrix_rank(
                world[fitting] - world[fitting].mean(axis=0), tol=1e-7
            )
            == 2
        ),
        "matches": [
            m.model_dump()
            | {
                "world": p.tolist(),
                "projected": (uv / size).tolist(),
                "error_px": float(e),
            }
            for m, p, uv, e in zip(alignment.matches, world, projected, errors)
        ],
        "method": "SQPnP and LM on fit points only; check points excluded. Calibration is supplied or estimated. Projection agreement does not verify physical scale or live position.",
    }


def fit_photo(document, alignment, size):
    world = world_points(document, alignment.matches)
    pixels = np.array([m.image for m in alignment.matches], dtype=np.float64) * size
    fitting = np.array([m.role == "fit" for m in alignment.matches])
    fit_world, fit_pixels = world[fitting], pixels[fitting]
    if len(fit_world) < 6:
        raise ValueError(
            "Photo alignment needs at least six fitting points, excluding check points."
        )
    if (
        np.linalg.matrix_rank(fit_world - fit_world.mean(axis=0), tol=1e-7) < 2
        or np.linalg.matrix_rank(fit_pixels - fit_pixels.mean(axis=0), tol=1e-5) < 2
    ):
        raise ValueError("Photo alignment needs non-collinear image and model points.")
    if len(np.unique(world.round(7), axis=0)) != len(world) or len(
        np.unique(pixels.round(4), axis=0)
    ) != len(pixels):
        raise ValueError(
            "Each fit/check landmark must use a distinct model point and image point."
        )
    intrinsic, distortion = camera_model(alignment, size)
    try:
        ok, rotation, translation = cv2.solvePnP(
            fit_world, fit_pixels, intrinsic, distortion, flags=cv2.SOLVEPNP_SQPNP
        )
        if not ok:
            raise ValueError("No camera fit found for these correspondences.")
        rotation, translation = cv2.solvePnPRefineLM(
            fit_world, fit_pixels, intrinsic, distortion, rotation, translation
        )
    except cv2.error as error:
        raise ValueError(
            "Camera fitting failed. Check landmark correspondences and lens estimate."
        ) from error
    return projection_report(document, alignment, size, rotation, translation)


def fit_photos(document, frames):
    sources = {frame["name"]: frame for frame in frames}
    output = []
    for alignment in document.alignments:
        if alignment.source not in sources:
            raise ValueError(
                "Photo alignment references an image outside this capture."
            )
        output.append(fit_photo(document, alignment, sources[alignment.source]["size"]))
    return output

"""Query-to-map feature correspondence and robust absolute camera pose."""

import json
import time
from functools import lru_cache
from pathlib import Path
from threading import Lock

import cv2
import numpy as np
import pycolmap

from . import store
from .geometry import camera_center, transform_points
from .reconstruction import decode_image, extraction_options


def normalized(descriptors):
    values = np.asarray(descriptors, dtype=np.float32)
    return np.ascontiguousarray(
        values / np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-8)
    )


def build_index(directory: Path, reconstruction):
    descriptors, xyz, point_ids, reference_ids = [], [], [], []
    references = []
    with pycolmap.Database.open(directory / "database.db") as database:
        for image in sorted(reconstruction.images.values(), key=lambda im: im.name):
            if not image.has_pose:
                continue
            desc = database.read_descriptors(image.image_id).to_float().data
            indices = [
                i for i, point in enumerate(image.points2D) if point.has_point3D()
            ]
            ids = [image.points2D[i].point3D_id for i in indices]
            descriptors.append(normalized(desc[indices]))
            xyz.extend(reconstruction.points3D[point].xyz for point in ids)
            point_ids.extend(ids)
            reference_ids.extend([len(references)] * len(ids))
            references.append(image.name)
    index = directory / "index"
    index.mkdir(exist_ok=True)
    np.savez_compressed(
        index / "features.npz",
        descriptors=np.concatenate(descriptors),
        xyz=np.array(xyz),
        point_ids=np.array(point_ids, dtype=np.int64),
        reference_ids=np.array(reference_ids, dtype=np.int32),
    )
    store.atomic_json(index / "references.json", references)


@lru_cache(maxsize=2)
def load_index(job_id: str, artifact_revision=None, index_file=None):
    directory = (
        store.artifact_dir(store.get_job(job_id), artifact_revision)
        if artifact_revision
        else store.job_dir(job_id)
    )
    with np.load(
        directory / index_file if index_file else directory / "index/features.npz"
    ) as archive:
        data = {name: archive[name] for name in archive.files}
    matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=128))
    matcher.add([data["descriptors"]])
    matcher.train()
    return (
        data,
        matcher,
        json.loads((directory / "guidance.json").read_text())["references"]
        if index_file
        else json.loads((directory / "index/references.json").read_text()),
        Lock(),
    )


def query_camera(calibration, size):
    if calibration:
        camera = pycolmap.Camera(
            model=calibration["model"],
            width=calibration["width"],
            height=calibration["height"],
            params=calibration["params"],
        )
        camera.rescale(*size)
        return camera
    width, height = size
    return pycolmap.Camera(
        model="SIMPLE_RADIAL",
        width=width,
        height=height,
        params=[1.2 * max(size), width / 2, height / 2, 0.0],
    )


def localize(job_id: str, path: Path, calibration=None, captured_at=None):
    started = time.perf_counter()
    job = store.get_job(job_id)
    structured = job["options"].get("engine") == "architecture"
    index = None
    if structured:
        from .architecture.landmarks import guidance

        index = guidance(store.artifact_dir(job))
        scene = {
            "mode": "architecture",
            "revision": job["revision"],
            "artifact_revision": job["artifact_revision"],
            "display_from_world": np.eye(4).tolist(),
        }
    else:
        scene = json.loads((store.artifact_dir(job) / "scene.json").read_text())
    base = {
        "status": "lost",
        "map_revision": scene.get("revision"),
        "position": None,
        "display_position": None,
        "world_to_camera": None,
        "reference": None,
        "inliers": 0,
        "captured_at": captured_at,
        "completed_at": None,
        "correspondences": 0,
        "calibration_source": (
            "provided" if calibration else "focal length estimated from correspondences"
        ),
    }
    minimum = 8 if structured else 20

    def finish(**values):
        return (
            base
            | values
            | {
                "latency_ms": round((time.perf_counter() - started) * 1000),
                "completed_at": time.time(),
            }
        )

    if not (index if structured else scene["localizable"]):
        return finish(
            reason=(
                "Position unknown. This architectural draft has no calibrated image-to-map landmarks. The observation is retained for Codex review."
                if scene["mode"] == "architecture"
                else "A single inferred surface is not a multi-view localization map."
            )
        )
    image, _ = decode_image(path)
    gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
    if structured:
        keys, descriptors = cv2.SIFT_create(nfeatures=4000).detectAndCompute(gray, None)
        keypoints = np.array([k.pt for k in keys])
    else:
        extractor = pycolmap.Sift(extraction_options(), device=pycolmap.Device.cpu)
        keypoints, descriptors = extractor.extract(np.ascontiguousarray(gray))
    if descriptors is None or len(descriptors) < minimum:
        return finish(
            reason="Too few image features. Point at a textured, well-lit area in the saved map."
        )
    data, matcher, references, lock = (
        load_index(job_id, scene["artifact_revision"], index["index_file"])
        if structured
        else load_index(job_id)
    )
    with lock:
        neighbors = matcher.knnMatch(
            normalized(descriptors),
            k=min(96 if structured else 8, len(data["descriptors"])),
        )
    correspondences = []
    for matches in neighbors:
        if not matches:
            continue
        best = matches[0]
        other = next(
            (
                match
                for match in matches[1:]
                if data["point_ids"][match.trainIdx] != data["point_ids"][best.trainIdx]
            ),
            None,
        )
        if other is not None and best.distance < 0.75 * other.distance:
            correspondences.append((best.distance, best.queryIdx, best.trainIdx))
    # One query pixel and one physical landmark per correspondence.
    used_points, used_queries, pairs = set(), set(), []
    for distance, query, reference in sorted(correspondences):
        point_id = int(data["point_ids"][reference])
        if point_id not in used_points and query not in used_queries:
            used_points.add(point_id)
            used_queries.add(query)
            pairs.append((query, reference))
    base["correspondences"] = len(pairs)
    if len(pairs) < minimum:
        return finish(
            reason="The frame does not have enough unambiguous map correspondences."
        )
    query_indices, reference_indices = np.array(pairs).T
    pixels = keypoints[query_indices, :2].astype(np.float64)
    points = data["xyz"][reference_indices]
    camera = query_camera(calibration, image.size)
    estimate = pycolmap.AbsolutePoseEstimationOptions()
    estimate.estimate_focal_length = calibration is None
    estimate.ransac.max_error = 4.0
    estimate.ransac.random_seed = 7
    refinement = pycolmap.AbsolutePoseRefinementOptions()
    refinement.refine_focal_length = calibration is None
    refinement.refine_extra_params = calibration is None
    result = pycolmap.estimate_and_refine_absolute_pose(
        pixels,
        points,
        camera,
        estimation_options=estimate,
        refinement_options=refinement,
    )
    if (
        result is None
        or result["num_inliers"] < minimum
        or result["num_inliers"] / len(pairs) < 0.2
    ):
        return finish(
            reason="Geometric pose verification failed. Move slowly and show more of a mapped area."
        )
    inliers = np.asarray(result["inlier_mask"], dtype=bool)
    if (
        structured
        and np.linalg.matrix_rank(
            points[inliers] - points[inliers].mean(axis=0), tol=1e-7
        )
        < 3
    ):
        return finish(
            reason="Matched landmarks lack depth variation. Position remains unknown."
        )
    pose = result["cam_from_world"].matrix()
    projected = camera.img_from_cam(points @ pose[:3, :3].T + pose[:3, 3])
    errors = np.linalg.norm(projected - pixels, axis=1)
    supported_pixels = pixels[inliers]
    coverage = float(
        cv2.contourArea(cv2.convexHull(supported_pixels.astype(np.float32)))
        / (image.width * image.height)
    )
    if coverage < 0.01:
        return finish(
            reason="Matched evidence is confined to too small an image region to accept a pose."
        )
    reference_votes = np.bincount(
        data["reference_ids"][reference_indices[inliers]], minlength=len(references)
    )
    reference = references[int(reference_votes.argmax())]
    center = camera_center(pose)
    display = transform_points([center], scene["display_from_world"])[0]
    forward = (
        np.asarray(scene["display_from_world"])[:3, :3]
        @ pose[:3, :3].T
        @ np.array([0.0, 0.0, 1.0])
    )
    scale = job.get("scale")
    return finish(
        status="localized",
        position=center.tolist(),
        display_position=display.tolist(),
        world_to_camera=pose.tolist(),
        display_forward=forward.tolist(),
        position_m=(center * scale["meters_per_unit"]).tolist() if scale else None,
        model_position_m=center.tolist() if structured else None,
        reference=reference,
        inliers=int(inliers.sum()),
        inlier_ratio=float(inliers.mean()),
        image_coverage=coverage,
        reprojection_error_px=float(np.median(errors[inliers])),
        reprojection_error_statistic="median over geometric inliers",
        scale_provenance=(
            "estimated architectural metres; physical accuracy unverified"
            if structured
            else "measured distance calibration"
            if scale
            else "unknown map units"
        ),
        camera={
            "model": camera.model_name,
            "width": camera.width,
            "height": camera.height,
            "params": camera.params.tolist(),
        },
    )

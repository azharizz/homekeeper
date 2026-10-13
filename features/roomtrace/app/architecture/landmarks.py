"""Small revision-specific localization index from explicitly observed 2D/3D anchors."""

import json
import hashlib
from uuid import uuid4

import cv2
import numpy as np
from PIL import Image

from .. import store
from . import Architecture


def guidance(directory):
    path = directory / "guidance.json"
    return json.loads(path.read_text()) if path.is_file() else None


def _write_landmarks(job, directory, scene, fits, max_error_px):
    document = Architecture.model_validate(scene["architecture"])
    observations = {}
    for fit in fits:
        for m in fit["matches"]:
            if m["role"] != "fit" or m["error_px"] > max_error_px:
                continue
            key = (
                m["element_id"],
                json.dumps(m.get("feature") or m["anchor"], sort_keys=True),
            )
            observations.setdefault(key, []).append((fit, m))
    observations = {key: rows for key, rows in observations.items() if len(rows) >= 2}
    if len(observations) < 8:
        raise ValueError(
            "Need at least eight shared fitting landmarks, each observed in two photos within the selected pixel error. Checks are never index training data."
        )
    xyz = np.array([rows[0][1]["world"] for rows in observations.values()])
    if np.linalg.matrix_rank(xyz - xyz.mean(axis=0), tol=1e-7) < 3:
        raise ValueError(
            "Landmarks need depth variation. Coplanar anchors alone cannot enable this localization index."
        )
    references = list(dict.fromkeys(f["source"] for f in fits))
    images = {}
    for source in references:
        with Image.open(store.job_dir(job["id"]) / "images" / source) as image:
            images[source] = np.asarray(image.convert("L"))
    sift = cv2.SIFT_create()
    detected = {source: sift.detect(image, None) for source, image in images.items()}
    descriptors, points, ids, reference_ids, evidence = [], [], [], [], []
    for index, (key, rows) in enumerate(observations.items()):
        accepted = []
        sampled = []
        for fit, match in rows:
            image = images[fit["source"]]
            uv = np.array(match["image"]) * fit["size"]
            candidates = detected[fit["source"]]
            if not candidates:
                continue
            closest = min(candidates, key=lambda p: np.linalg.norm(np.array(p.pt) - uv))
            if np.linalg.norm(np.array(closest.pt) - uv) > max_error_px:
                continue
            # Use the image detector's scale/orientation, but never move the declared 2D/3D correspondence.
            keys = [
                cv2.KeyPoint(float(uv[0]), float(uv[1]), closest.size, closest.angle)
            ]
            _, desc = sift.compute(image, keys)
            if desc is None:
                continue
            desc = desc[np.linalg.norm(desc, axis=1) > 1e-8]
            if not len(desc):
                continue
            sampled.append((desc, match["world"], references.index(fit["source"])))
            accepted.append(
                {
                    "source": fit["source"],
                    "image": match["image"],
                    "error_px": match["error_px"],
                }
            )
        if len(sampled) < 2:
            continue
        evidence.append(
            {
                "id": index,
                "element_id": key[0],
                "anchor": rows[0][1].get("anchor"),
                "feature": rows[0][1].get("feature"),
                "world": rows[0][1]["world"],
                "observations": accepted,
            }
        )
        for desc, point, ref in sampled:
            descriptors.extend(desc)
            points.extend([point] * len(desc))
            ids.extend([index] * len(desc))
            reference_ids.extend([ref] * len(desc))
    if len(set(ids)) < 8:
        raise ValueError("Too few source landmarks produced usable image descriptors.")
    usable = np.array([item["world"] for item in evidence])
    if np.linalg.matrix_rank(usable - usable.mean(axis=0), tol=1e-7) < 3:
        raise ValueError("Usable image landmarks need depth variation.")
    values = np.asarray(descriptors, dtype=np.float32)
    values /= np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-8)
    token = uuid4().hex
    filename = f"landmarks-{token}.npz"
    np.savez_compressed(
        directory / filename,
        descriptors=values,
        xyz=np.array(points),
        point_ids=np.array(ids),
        reference_ids=np.array(reference_ids),
    )
    result = {
        "revision": scene["revision"],
        "artifact_revision": scene["artifact_revision"],
        "units": "estimated_metres",
        "physically_verified": False,
        "index_file": filename,
        "index_bytes": (directory / filename).stat().st_size,
        "landmark_count": len(set(ids)),
        "references": references,
        "source_images": [
            {
                "name": source,
                "sha256": hashlib.sha256(
                    (store.job_dir(job["id"]) / "images" / source).read_bytes()
                ).hexdigest(),
            }
            for source in references
        ],
        "max_source_error_px": max_error_px,
        "landmarks": evidence,
        "levels": scene["architecture"]["levels"],
        "cameras": scene.get("cameras", []),
        "validation": scene["guide_readiness"]["validation"],
        "geometry": {
            key: {
                "bounds": c["bounds"],
                "footprint": c["footprint"],
                "surfaces": c.get("surfaces"),
            }
            for key, c in scene["components"].items()
        },
        "structure": [
            element.model_dump(
                include={
                    "id",
                    "kind",
                    "level",
                    "start",
                    "end",
                    "bottom",
                    "height",
                    "thickness",
                    "openings",
                    "polygon",
                    "holes",
                    "top",
                    "width",
                    "risers",
                    "to_level",
                    "opening",
                    "flights",
                    "landings",
                }
            )
            for element in document.elements
            if element.kind in {"wall", "slab", "stair", "staircase"}
        ],
        "measurements": scene.get("measurement_checks", []),
        "limits": "Observed landmarks attached to estimated geometry. Map-relative pose is not surveyed physical position; plan hulls are not walking clearance. No detailed mesh is needed to localize.",
    }
    store.atomic_json(directory / "guidance.json", result)
    return result


def calibrate_scene(job, directory, scene, fits, failures, max_error_px=4.0):
    """Prepare revision-owned evidence before publication, without certifying navigation."""
    checks = [
        {
            "source": fit["source"],
            "check_count": fit["check_count"],
            "rmse_px": fit["check_rmse_px"],
            "max_error_px": fit["check_max_error_px"],
        }
        for fit in fits
        if fit["check_count"]
    ]
    worst = max((row["max_error_px"] for row in checks), default=None)
    validation = {
        "status": "missing" if worst is None else "passed" if worst <= max_error_px else "failed",
        "check_count": sum(row["check_count"] for row in checks),
        "max_error_px": worst,
        "threshold_px": max_error_px,
        "sources": checks,
        "limits": "Held-out declared check points test projection only, not live localization or physical accuracy.",
    }
    reasons = [f"{item['source']}: {item['reason']}" for item in failures]
    if not fits:
        reasons.append("No fitted source cameras. Supply observed photo-to-model correspondences and exact lens calibration.")
    uncalibrated = [fit["source"] for fit in fits if not fit["calibration_supplied"]]
    if uncalibrated:
        reasons.append("Exact source lens calibration is missing for: " + ", ".join(uncalibrated))
    if validation["status"] == "failed":
        reasons.append("Held-out projection checks exceed the selected pixel error threshold.")
    readiness = {
        "status": "needs_calibration",
        "ready": False,
        "reasons": reasons,
        "revision": scene["revision"],
        "artifact_revision": scene["artifact_revision"],
        "landmark_count": 0,
        "camera_count": sum(fit["calibration_supplied"] for fit in fits),
        "max_source_error_px": max_error_px,
        "validation": validation,
        "units": "estimated_metres",
        "physically_verified": False,
        "limits": "Ready means a revision-owned visual localization index exists; it does not mean verified scale, live pose, obstacle clearance or safe walking.",
    }
    scene["guide_readiness"] = readiness
    scene["localizable"] = False
    scene["landmark_count"] = 0
    result = None
    if not reasons:
        try:
            result = _write_landmarks(job, directory, scene, fits, max_error_px)
        except (ValueError, OSError, cv2.error) as error:
            reasons.append(str(error))
    if result is not None:
        readiness.update(status="ready", ready=True, landmark_count=result["landmark_count"])
        scene.update(localizable=True, landmark_count=result["landmark_count"])
    return result

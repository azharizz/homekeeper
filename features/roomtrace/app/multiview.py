"""Fuse learned multi-view depth, preserving predicted coordinates and provenance."""

import subprocess
import sys
import json

import cv2
import numpy as np
import open3d as o3d
import pycolmap
import trimesh

from . import config, store
from .geometry import camera_display_frame, transform_points, write_geometry
from .localization import normalized
from .multiview_inference import MODEL_ID, REVISION
from .reconstruction import extraction_options


def pinhole_points(prediction):
    y, x = np.indices(prediction["depth"].shape)
    pixels = np.stack((x, y, np.ones_like(x)), axis=-1)
    camera = (pixels @ np.linalg.inv(prediction["intrinsics"]).T) * prediction["depth"][
        ..., None
    ]
    return transform_points(
        camera.reshape(-1, 3), prediction["camera_to_world"]
    ).reshape(camera.shape)


def consistent_depth_masks(predictions, voxel):
    """Reject points lying in another view's observed free space; occluded points remain unknown."""
    masks = []
    for source in predictions:
        points = pinhole_points(source).reshape(-1, 3)
        valid = (
            source["mask"].reshape(-1).copy()
            & np.isfinite(points).all(axis=1)
            & (source["depth"].reshape(-1) > 0)
        )
        for target in predictions:
            if target is source:
                continue
            camera = transform_points(points, np.linalg.inv(target["camera_to_world"]))
            z = camera[:, 2]
            uv = camera @ target["intrinsics"].T
            uv = np.rint(uv[:, :2] / np.maximum(z[:, None], 1e-8)).astype(np.int64)
            height, width = target["depth"].shape
            visible = (
                valid
                & (z > 0)
                & (uv[:, 0] >= 0)
                & (uv[:, 0] < width)
                & (uv[:, 1] >= 0)
                & (uv[:, 1] < height)
            )
            indices = np.flatnonzero(visible)
            x, y = uv[indices].T
            observed = target["depth"][y, x]
            supported = target["mask"][y, x] & np.isfinite(observed) & (observed > 0)
            contradiction = supported & (
                z[indices] < observed - np.maximum(0.05 * observed, 4 * voxel)
            )
            valid[indices[contradiction]] = False
        masks.append(valid.reshape(source["depth"].shape))
    return masks


def reconstruct_multiview(directory, frames, stage, calibration=None):
    stage("Predicting shared multi-view geometry with MapAnything")
    command = [sys.executable, "-m", "app.multiview_inference", str(directory)]
    if calibration:
        command.extend(["--calibration", json.dumps(calibration)])
    subprocess.run(command, cwd=config.ROOT, check=True)
    stage("Fusing inferred surfaces and indexing visible landmarks")
    return fuse_predictions(directory, frames)


def fuse_predictions(directory, frames):
    predictions = []
    for frame in frames:
        with np.load(
            directory / "predictions" / (frame["name"].split(".")[0] + ".npz")
        ) as archive:
            predictions.append({key: archive[key] for key in archive.files})
    distances = np.concatenate(
        [
            p["depth"][
                p["mask"].astype(bool) & np.isfinite(p["depth"]) & (p["depth"] > 0)
            ]
            for p in predictions
        ]
    )
    if not len(distances):
        raise ValueError("The multi-view model produced no supported depth.")
    # Sampling density follows scene depth. This does not certify the model's scale.
    voxel = float(np.median(distances) / 180)
    masks = consistent_depth_masks(predictions, voxel)
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel,
        sdf_trunc=4 * voxel,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
    )
    display = camera_display_frame(np.linalg.inv(predictions[0]["camera_to_world"]))
    descriptors, xyz, reference_ids, cameras = [], [], [], []
    extractor = pycolmap.Sift(extraction_options(), device=pycolmap.Device.cpu)
    for index, (frame, prediction) in enumerate(zip(frames, predictions)):
        depth, rgb, k = prediction["depth"], prediction["rgb"], prediction["intrinsics"]
        valid = masks[index]
        depth = np.where(valid, depth, 0).astype(np.float32)
        pose = np.linalg.inv(prediction["camera_to_world"])
        height, width = depth.shape
        intrinsic = o3d.camera.PinholeCameraIntrinsic(
            width,
            height,
            float(k[0, 0]),
            float(k[1, 1]),
            float(k[0, 2]),
            float(k[1, 2]),
        )
        image = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.ascontiguousarray(rgb)),
            o3d.geometry.Image(depth),
            depth_scale=1.0,
            depth_trunc=float(distances.max() * 1.01),
            convert_rgb_to_intensity=False,
        )
        volume.integrate(image, intrinsic, pose)
        keypoints, desc = extractor.extract(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY))
        pixels = np.rint(keypoints[:, :2]).astype(int)
        pixels[:, 0] = np.clip(pixels[:, 0], 0, width - 1)
        pixels[:, 1] = np.clip(pixels[:, 1], 0, height - 1)
        keep = valid[pixels[:, 1], pixels[:, 0]]
        descriptors.append(normalized(desc[keep]))
        rays = (
            np.column_stack((keypoints[keep, :2], np.ones(int(keep.sum()))))
            @ np.linalg.inv(k).T
        )
        sampled_depth = depth[pixels[keep, 1], pixels[keep, 0]]
        xyz.extend(
            transform_points(
                rays * sampled_depth[:, None], prediction["camera_to_world"]
            )
        )
        reference_ids.extend([index] * int(keep.sum()))
        center = prediction["camera_to_world"][:3, 3]
        cameras.append(
            {
                "id": index,
                "name": frame["name"],
                "position": center.tolist(),
                "display_position": transform_points([center], display)[0].tolist(),
                "world_to_camera": pose[:3].tolist(),
                "camera_model": "PINHOLE",
                "params": [
                    float(k[0, 0]),
                    float(k[1, 1]),
                    float(k[0, 2]),
                    float(k[1, 2]),
                ],
                "width": width,
                "height": height,
                "pose_source": "joint model inference",
            }
        )
    fused = volume.extract_triangle_mesh()
    fused.remove_duplicated_triangles().remove_degenerate_triangles().remove_unreferenced_vertices()
    colors = (np.asarray(fused.vertex_colors) * 255).round().astype(np.uint8)
    mesh = trimesh.Trimesh(
        np.asarray(fused.vertices),
        np.asarray(fused.triangles),
        vertex_colors=colors,
        process=False,
    )
    if not len(mesh.faces):
        raise ValueError(
            "Predicted views did not fuse into a surface. Inspect viewpoint overlap and scene consistency."
        )
    write_geometry(directory, mesh, mesh.vertices, colors)
    index_dir = directory / "index"
    index_dir.mkdir(exist_ok=True)
    np.savez_compressed(
        index_dir / "features.npz",
        descriptors=np.concatenate(descriptors),
        xyz=np.array(xyz),
        point_ids=np.arange(len(xyz), dtype=np.int64),
        reference_ids=np.array(reference_ids, dtype=np.int32),
    )
    store.atomic_json(
        index_dir / "references.json", [frame["name"] for frame in frames]
    )
    points = transform_points(mesh.vertices, display)
    step = max(1, int(np.ceil(len(points) / 20000)))
    return {
        "mode": "inferred_multiview",
        "geometry_source": MODEL_ID,
        "model_revision": REVISION,
        "display_from_world": display.tolist(),
        "points": points[::step].round(6).tolist(),
        "colors": colors[::step].tolist(),
        "bounds": [
            np.quantile(points, 0.01, axis=0).tolist(),
            np.quantile(points, 0.99, axis=0).tolist(),
        ],
        "cameras": cameras,
        "registered_frames": len(frames),
        "total_frames": len(frames),
        "sparse_points": len(xyz),
        "surface_vertices": len(mesh.vertices),
        "surface_triangles": len(mesh.faces),
        "reprojection_error_px": None,
        "localizable": len(xyz) >= 20,
        "scale_provenance": "Learned scale, not independently measured",
        "quality_status": "Unverified inferred geometry",
        "voxel_size_map_units": voxel,
        "depth_consistency_retained_fraction": [
            float(mask.sum() / max(1, prediction["mask"].sum()))
            for mask, prediction in zip(masks, predictions)
        ],
        "pose_source": "Model predicted cameras; not COLMAP registrations",
        "limitations": [
            "Views may disagree or drift; a dense mesh is not evidence of accuracy.",
            "Water, mirrors, stairs and hidden areas require independent verification.",
            "Localization is relative to inferred geometry; no safe walking route is established.",
        ],
    }

"""Single-photo learned depth. Never presented as measured hidden geometry."""

import subprocess
import sys

import cv2
import numpy as np
from PIL import Image

from . import config, store
from .geometry import (
    camera_display_frame,
    depth_surface,
    transform_points,
    write_geometry,
)
from .localization import query_camera

from .depth_inference import MODEL_ID, REVISION


def reconstruct_photo(directory, frame, stage):
    stage("Loading the pretrained depth model")
    image = Image.open(directory / "images" / frame["name"]).convert("RGB")
    image.thumbnail((config.DENSE_SIZE, config.DENSE_SIZE), Image.Resampling.LANCZOS)
    stage("Inferring the visible surface from the photo")
    # Native PyCOLMAP and PyTorch wheels bundle conflicting OpenMP runtimes on macOS.
    # Keep inference in a real isolated process, without allowing duplicate runtimes.
    subprocess.run(
        [
            sys.executable,
            "-m",
            "app.depth_inference",
            str(directory / "images" / frame["name"]),
            str(directory / "inferred_depth.npy"),
        ],
        cwd=config.ROOT,
        check=True,
    )
    depth = np.load(directory / "inferred_depth.npy")
    job = store.get_job(directory.name)
    calibration = job["options"].get("calibration")
    camera = query_camera(calibration, image.size)
    if calibration and camera.model_name not in {"PINHOLE", "SIMPLE_PINHOLE"}:
        # Backproject distorted pixels with the camera model before surface construction.
        y, x = np.indices(depth.shape)
        # Remap the RGB and depth to a pinhole image with the same K.
        k = camera.calibration_matrix()
        ideal = np.column_stack(
            (
                (x.ravel() - k[0, 2]) / k[0, 0],
                (y.ravel() - k[1, 2]) / k[1, 1],
                np.ones(x.size),
            )
        )
        source = (
            camera.img_from_cam(ideal)
            .reshape(image.height, image.width, 2)
            .astype(np.float32)
        )
        rgb = cv2.remap(
            np.array(image), source[..., 0], source[..., 1], cv2.INTER_LINEAR
        )
        depth = cv2.remap(depth, source[..., 0], source[..., 1], cv2.INTER_LINEAR)
    else:
        rgb = np.array(image)
    pose = np.eye(4)
    mesh = depth_surface(depth, rgb, camera.calibration_matrix(), pose)
    if not len(mesh.faces):
        raise ValueError("The depth model did not produce a usable visible surface.")
    write_geometry(directory, mesh, mesh.vertices, mesh.visual.vertex_colors[:, :3])
    np.save(directory / "inferred_depth.npy", depth)
    display = camera_display_frame(pose)
    points = transform_points(mesh.vertices, display)
    step = max(1, int(np.ceil(len(points) / 15000)))
    return {
        "mode": "single_photo",
        "geometry_source": MODEL_ID,
        "model_revision": REVISION,
        "display_from_world": display.tolist(),
        "points": points[::step].round(6).tolist(),
        "colors": mesh.visual.vertex_colors[::step, :3].tolist(),
        "bounds": [
            np.quantile(points, 0.01, axis=0).tolist(),
            np.quantile(points, 0.99, axis=0).tolist(),
        ],
        "cameras": [
            {
                "id": 0,
                "name": frame["name"],
                "position": [0, 0, 0],
                "display_position": [0, 0, 0],
                "world_to_camera": pose[:3].tolist(),
                "camera_model": camera.model_name,
                "params": camera.params.tolist(),
                "width": image.width,
                "height": image.height,
            }
        ],
        "registered_frames": 1,
        "total_frames": 1,
        "sparse_points": 0,
        "surface_vertices": len(mesh.vertices),
        "surface_triangles": len(mesh.faces),
        "reprojection_error_px": None,
        "localizable": False,
        "scale_provenance": "Learned indoor depth, not independently measured",
        "intrinsics_source": "provided" if calibration else "assumed focal length",
    }

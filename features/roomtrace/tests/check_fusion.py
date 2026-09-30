"""Regression: Open3D 0.20 macOS returned empty scalable volumes for this depth plane."""

import numpy as np
import open3d as o3d
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.multiview import consistent_depth_masks

camera = o3d.camera.PinholeCameraIntrinsic(320, 240, 250.0, 250.0, 160.0, 120.0)
image = o3d.geometry.RGBDImage.create_from_color_and_depth(
    o3d.geometry.Image(np.full((240, 320, 3), 128, np.uint8)),
    o3d.geometry.Image(np.full((240, 320), 2, np.float32)),
    depth_scale=1.0,
    depth_trunc=5.0,
    convert_rgb_to_intensity=False,
)
volume = o3d.pipelines.integration.ScalableTSDFVolume(
    0.04, 0.16, o3d.pipelines.integration.TSDFVolumeColorType.RGB8
)
volume.integrate(image, camera, np.eye(4))
mesh = volume.extract_triangle_mesh()
vertices = np.asarray(mesh.vertices)
assert len(mesh.triangles) > 1000, "Depth integration produced no useful surface."
assert np.max(np.abs(vertices[:, 2] - 2)) < 0.01, (
    "Optical depth or pose conversion is wrong."
)
print(f"PASS: {len(mesh.triangles)} triangles on the known depth plane")


def plane(depth):
    return {
        "depth": np.full((12, 16), depth),
        "mask": np.ones((12, 16), bool),
        "intrinsics": np.array([[12.0, 0, 8], [0, 12.0, 6], [0, 0, 1]]),
        "camera_to_world": np.eye(4),
    }


same = consistent_depth_masks([plane(2.0), plane(2.0)], 0.01)
assert all(mask.all() for mask in same)
near, far = consistent_depth_masks([plane(1.0), plane(2.0)], 0.01)
assert not near.any() and far.all(), (
    "Free-space contradictions must be removed without deleting occluded depth."
)
print("PASS: overlapping depth agreement, free-space contradiction, and occlusion")

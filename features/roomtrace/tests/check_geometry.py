"""Small math checks independent of the public-data acceptance tests."""

import sys
import json
import tempfile
from pathlib import Path

import cv2
import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.geometry import (
    camera_center,
    camera_display_frame,
    depth_surface,
    transform_points,
    write_geometry,
)
from app.reconstruction import stereo_pair, prepare_frames


def main():
    pose = np.eye(4)
    pose[:3, 3] = [-2, 3, -4]
    assert np.allclose(camera_center(pose), [2, -3, 4])
    assert np.allclose(
        transform_points([camera_center(pose)], camera_display_frame(pose)), 0
    )
    intrinsics = np.array([[200.0, 0, 160], [0, 200, 120], [0, 0, 1]])
    depth = np.full((240, 320), 4.0)
    rgb = np.full((240, 320, 3), 128, np.uint8)
    mesh = depth_surface(depth, rgb, intrinsics, np.eye(4))
    assert len(mesh.faces) > 1000 and np.allclose(mesh.vertices[:, 2], 4)
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        write_geometry(folder, mesh, mesh.vertices, mesh.visual.vertex_colors[:, :3])
        exported = trimesh.load(folder / "surface.glb", force="mesh", process=False)
        cloud = trimesh.load(folder / "points.ply", process=False)
        assert np.all(exported.visual.vertex_colors[:, :3] == 55), (
            "sRGB 128 must be linear 55 in GLB."
        )
        assert np.all(cloud.colors[:, :3] == 128), (
            "PLY preserves original photo colors."
        )
        assert np.all(mesh.visual.vertex_colors[:, :3] == 128), (
            "Export must not alter source colors."
        )
    empty = depth_surface(
        depth, rgb, intrinsics, np.eye(4), np.zeros_like(depth, dtype=bool)
    )
    assert len(empty.faces) == 0
    rng = np.random.default_rng(7)
    texture = cv2.GaussianBlur(
        rng.integers(0, 256, (240, 320, 3), dtype=np.uint8), (3, 3), 0
    )
    # A plane at z=4 with f=200 and baseline=.2 has disparity=10 pixels.
    for axis in [0, 1]:
        for direction in [-1, 1]:
            translation = np.eye(4)
            translation[axis, 3] = -0.2 * direction
            right = np.roll(texture, -10 * direction, axis=1 - axis)
            surface = stereo_pair(
                texture, right, intrinsics, intrinsics, np.eye(4), translation, 10
            )
            assert len(surface.faces) > 1000, (axis, direction, "missing surface")
            assert abs(np.median(surface.vertices[:, 2]) - 4) < 0.08, (
                axis,
                direction,
                "wrong depth",
            )
    print(
        "PASS: camera frame, optical depth, empty support, and four stereo baseline orientations"
    )
    # Encoded synthetic fixtures test ingestion bounds only, not reconstruction accuracy.
    for count, expected in [(4, 4), (300, 12)]:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "uploads").mkdir()
            movie = directory / "uploads/test.avi"
            writer = cv2.VideoWriter(
                str(movie), cv2.VideoWriter_fourcc(*"MJPG"), 20, (320, 240)
            )
            assert writer.isOpened()
            for index in range(count):
                writer.write(np.full((240, 320, 3), index % 255, dtype=np.uint8))
            writer.release()
            (directory / "uploads.json").write_text(
                json.dumps([{"stored": "test.avi", "original": "test.avi"}])
            )
            frames = prepare_frames(directory, {"source": "video"})
            assert len(frames) == expected
            assert (
                frames[0]["frame_index"] == 0 and frames[-1]["frame_index"] == count - 1
            )
    print("PASS: encoded video sampling retains 4 to 12 frames across the full clip")


if __name__ == "__main__":
    main()

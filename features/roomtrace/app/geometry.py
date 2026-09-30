"""Coordinate and surface operations shared by reconstruction and localization."""

import numpy as np
import trimesh


def transform_points(points, matrix):
    points = np.asarray(points)
    return points @ np.asarray(matrix)[:3, :3].T + np.asarray(matrix)[:3, 3]


def camera_center(world_to_camera):
    pose = np.asarray(world_to_camera)
    return -pose[:3, :3].T @ pose[:3, 3]


def camera_display_frame(world_to_camera):
    """First camera upright, looking toward -Z. This is not a surveyed floor."""
    pose = np.eye(4)
    pose[:3] = np.asarray(world_to_camera)[:3]
    return np.diag([1.0, -1.0, -1.0, 1.0]) @ pose


def depth_surface(depth, rgb, intrinsics, world_to_camera, valid=None, stride=2):
    """Triangulate neighboring supported samples without bridging depth edges."""
    depth = np.asarray(depth)
    yy, xx = np.mgrid[0 : depth.shape[0] : stride, 0 : depth.shape[1] : stride]
    z = depth[::stride, ::stride]
    mask = np.isfinite(z) & (z > 0)
    if valid is not None:
        mask &= valid[::stride, ::stride]
    rays = np.stack((xx, yy, np.ones_like(xx)), axis=-1) @ np.linalg.inv(intrinsics).T
    camera_points = rays * np.where(mask, z, 0)[..., None]
    camera_to_world = np.linalg.inv(world_to_camera)
    points = transform_points(camera_points.reshape(-1, 3), camera_to_world)
    colors = rgb[::stride, ::stride].reshape(-1, 3)
    rows, cols = z.shape
    grid = np.arange(rows * cols).reshape(rows, cols)
    a, b, c, d = grid[:-1, :-1], grid[:-1, 1:], grid[1:, :-1], grid[1:, 1:]
    faces = np.concatenate(
        (np.stack((a, c, b), -1).reshape(-1, 3), np.stack((b, c, d), -1).reshape(-1, 3))
    )
    depths = np.where(mask, z, 0).reshape(-1)[faces]
    supported = mask.reshape(-1)[faces].all(axis=1)
    # ponytail: local surface patches retain holes; use multi-view TSDF for a fused manifold.
    supported &= np.ptp(depths, axis=1) < 0.05 * np.maximum(
        np.min(depths, axis=1), 1e-8
    )
    mesh = trimesh.Trimesh(
        points, faces[supported], vertex_colors=colors, process=False
    )
    mesh.remove_unreferenced_vertices()
    return mesh


def write_geometry(directory, mesh, points, colors):
    cloud = trimesh.points.PointCloud(points, colors=colors)
    cloud.export(directory / "points.ply")
    if len(mesh.faces):
        exported = mesh.copy()
        rgba = mesh.visual.vertex_colors.copy()
        # Photos and PLY use sRGB; glTF COLOR_0 is a linear multiplier.
        rgba[:, :3] = np.rint(
            trimesh.visual.color.srgb_to_linear(rgba[:, :3]) * 255
        ).astype(np.uint8)
        exported.visual.vertex_colors = rgba
        exported.metadata.update(
            units="uncalibrated_map_units", vertex_color_space="linear"
        )
        exported.export(directory / "surface.glb")


def sparse_scene(reconstruction):
    images = sorted(
        (im for im in reconstruction.images.values() if im.has_pose),
        key=lambda im: im.name,
    )
    display = camera_display_frame(images[0].cam_from_world().matrix())
    points = list(reconstruction.points3D.values())
    xyz = np.array([p.xyz for p in points])
    colors = np.array([p.color for p in points], dtype=np.uint8)
    display_points = transform_points(xyz, display)
    cameras = []
    for im in images:
        pose = im.cam_from_world().matrix()
        cam = reconstruction.cameras[im.camera_id]
        cameras.append(
            {
                "id": im.image_id,
                "name": im.name,
                "position": im.projection_center().tolist(),
                "display_position": transform_points([im.projection_center()], display)[
                    0
                ].tolist(),
                "world_to_camera": pose.tolist(),
                "camera_model": cam.model_name,
                "width": cam.width,
                "height": cam.height,
                "params": cam.params.tolist(),
            }
        )
    # Limit only browser payload; full-resolution geometry remains downloadable.
    step = max(1, int(np.ceil(len(xyz) / 20000)))
    return (
        {
            "display_from_world": display.tolist(),
            "cameras": cameras,
            "points": display_points[::step].round(6).tolist(),
            "colors": colors[::step].tolist(),
            "bounds": [
                np.quantile(display_points, 0.01, axis=0).tolist(),
                np.quantile(display_points, 0.99, axis=0).tolist(),
            ],
        },
        xyz,
        colors,
    )

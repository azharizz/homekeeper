"""Real image/video ingestion, COLMAP mapping, and calibrated stereo surfaces."""

import json
import shutil
import time
from pathlib import Path

import cv2
import numpy as np
import pycolmap
import trimesh
from PIL import Image, ImageOps, UnidentifiedImageError

from . import config, store
from .geometry import depth_surface, sparse_scene, write_geometry

Image.MAX_IMAGE_PIXELS = 40_000_000
cv2.setNumThreads(config.THREADS)


def decode_image(path: Path, maximum=config.IMAGE_SIZE):
    try:
        with Image.open(path) as source:
            if source.width * source.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError("Image exceeds the 40 megapixel limit.")
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGB")
            original_size = image.size
            image.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
            if min(image.size) < 64:
                raise ValueError("Images must be at least 64 pixels in each dimension.")
            return image.copy(), original_size
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError(
            "An image cannot be decoded or exceeds the 40 megapixel limit."
        ) from error


def prepare_frames(directory: Path, options: dict):
    uploads = json.loads((directory / "uploads.json").read_text())
    target = directory / "images"
    target.mkdir(exist_ok=True)
    frames = []
    if options["source"] == "video":
        capture = cv2.VideoCapture(str(directory / "uploads" / uploads[0]["stored"]))
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or count < 4 or not np.isfinite(fps) or fps <= 0:
            capture.release()
            raise ValueError(
                "The video cannot be decoded. Export an MP4 or upload overlapping photos."
            )
        indices = np.unique(
            np.linspace(
                0,
                count - 1,
                min(count, config.MAX_IMAGES, max(4, int(count / fps * 2))),
            ).astype(int)
        )
        try:
            for index in indices:
                capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
                ok, bgr = capture.read()
                if not ok:
                    continue
                image = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                original_size = image.size
                image.thumbnail(
                    (config.IMAGE_SIZE, config.IMAGE_SIZE), Image.Resampling.LANCZOS
                )
                name = f"{len(frames):05d}.jpg"
                image.save(target / name, quality=95)
                frames.append(
                    {
                        "name": name,
                        "original": uploads[0]["original"],
                        "frame_index": int(index),
                        "timestamp": float(index / fps),
                        "original_size": original_size,
                        "size": image.size,
                    }
                )
        finally:
            capture.release()
    else:
        for upload in uploads:
            image, original_size = decode_image(
                directory / "uploads" / upload["stored"]
            )
            name = f"{len(frames):05d}.jpg"
            image.save(target / name, quality=95)
            frames.append(
                {
                    "name": name,
                    "original": upload["original"],
                    "original_size": original_size,
                    "size": image.size,
                }
            )
    if not frames:
        raise ValueError("No usable frames were decoded.")
    if len(frames) in {2, 3} or (options["source"] == "video" and len(frames) < 4):
        raise ValueError(
            "Use one photo for an inferred surface, or 4 to 12 overlapping views for a map."
        )
    store.atomic_json(directory / "frames.json", frames)
    return frames


def extraction_options():
    options = pycolmap.FeatureExtractionOptions()
    options.num_threads = config.THREADS
    options.max_image_size = config.IMAGE_SIZE
    options.sift.max_num_features = 6000
    options.use_gpu = config.DEVICE == "cuda"
    return options


def run_sfm(directory: Path, options: dict, stage):
    if config.DEVICE == "cuda" and not pycolmap.has_cuda:
        raise ValueError(
            "CUDA requested but this PyCOLMAP build has no CUDA support. Install the CUDA profile or select cpu."
        )
    device = pycolmap.Device.cuda if config.DEVICE == "cuda" else pycolmap.Device.cpu
    reader = pycolmap.ImageReaderOptions()
    calibration = options.get("calibration")
    frames = json.loads((directory / "frames.json").read_text())
    if calibration:
        camera = pycolmap.Camera(
            model=calibration["model"],
            width=calibration["width"],
            height=calibration["height"],
            params=calibration["params"],
        )
        camera.rescale(*frames[0]["size"])
        reader.camera_model = camera.model_name
        reader.camera_params = camera.params_to_string()
    same_size = len({tuple(f["size"]) for f in frames}) == 1
    if calibration and not same_size:
        raise ValueError(
            "A shared calibration requires all uploaded images to have the same dimensions."
        )
    stage("Extracting image features")
    pycolmap.extract_features(
        directory / "database.db",
        directory / "images",
        camera_mode=(
            pycolmap.CameraMode.SINGLE if same_size else pycolmap.CameraMode.AUTO
        ),
        reader_options=reader,
        extraction_options=extraction_options(),
        device=device,
    )
    matching = pycolmap.FeatureMatchingOptions()
    matching.num_threads = config.THREADS
    matching.use_gpu = config.DEVICE == "cuda"
    matching.guided_matching = True
    stage("Matching views and checking geometry")
    pycolmap.match_exhaustive(
        directory / "database.db", matching_options=matching, device=device
    )
    mapper = pycolmap.IncrementalPipelineOptions()
    mapper.num_threads = config.THREADS
    mapper.random_seed = 7
    mapper.min_model_size = 3
    mapper.mapper.init_min_tri_angle = 4.0
    # Keep verified two-view tracks so adjacent overlap can grow into longer tracks.
    mapper.triangulation.ignore_two_view_tracks = False
    if calibration:
        # Fixed, supplied distortion can legitimately exceed COLMAP's default bound of 1.
        mapper.max_extra_param = max(
            1.0,
            float(np.max(np.abs(camera.params[camera.extra_params_idxs()]), initial=0))
            * 1.01,
        )
        mapper.ba_refine_focal_length = False
        mapper.ba_refine_extra_params = False
        mapper.mapper.abs_pose_refine_focal_length = False
        mapper.mapper.abs_pose_refine_extra_params = False
    stage("Triangulating and refining cameras")
    output = directory / "models"
    output.mkdir(exist_ok=True)
    models = pycolmap.incremental_mapping(
        directory / "database.db", directory / "images", output, options=mapper
    )
    if not models:
        raise ValueError(
            "No connected 3D map could be reconstructed. Capture more overlap, texture, and sideways camera movement."
        )
    reconstruction = max(models.values(), key=lambda model: model.num_reg_images())
    if reconstruction.num_reg_images() < 3 or reconstruction.num_points3D() < 50:
        raise ValueError(
            "Insufficient multi-view geometry. Capture at least three sharp overlapping views with translation."
        )
    sparse = directory / "sparse"
    sparse.mkdir(exist_ok=True)
    reconstruction.write(sparse)
    return reconstruction, len(models)


def stereo_pair(left, right, cam1, cam2, pose1, pose2, far_depth):
    """Rectify a calibrated pair. Return a supported mesh in the shared map frame."""
    size = (left.shape[1], left.shape[0])
    rotation = pose2[:3, :3] @ pose1[:3, :3].T
    translation = pose2[:3, 3] - rotation @ pose1[:3, 3]
    if np.linalg.norm(translation) < 1e-6:
        return trimesh.Trimesh()
    r1, r2, p1, p2, q, _, _ = cv2.stereoRectify(
        cam1,
        None,
        cam2,
        None,
        size,
        rotation,
        translation.reshape(3, 1),
        flags=cv2.CALIB_ZERO_DISPARITY,
        alpha=0,
    )
    # SGBM searches horizontal epipolar lines. Rotate vertical rectification explicitly.
    vertical = abs(p2[1, 3]) > abs(p2[0, 3])
    map1 = cv2.initUndistortRectifyMap(cam1, None, r1, p1, size, cv2.CV_32FC1)
    map2 = cv2.initUndistortRectifyMap(cam2, None, r2, p2, size, cv2.CV_32FC1)
    a = cv2.remap(left, *map1, cv2.INTER_LINEAR)
    b = cv2.remap(right, *map2, cv2.INTER_LINEAR)
    if vertical:
        a, b = a.transpose(1, 0, 2).copy(), b.transpose(1, 0, 2).copy()
    axis = 1 if vertical else 0
    sign = -np.sign(p2[axis, 3])
    disparities = min(128, (a.shape[1] // 3 // 16) * 16)
    minimum = 0 if sign > 0 else -disparities

    def match(first, second, min_disp):
        matcher = cv2.StereoSGBM_create(
            minDisparity=int(min_disp),
            numDisparities=disparities,
            blockSize=5,
            P1=8 * 25,
            P2=32 * 25,
            disp12MaxDiff=1,
            uniquenessRatio=10,
            speckleWindowSize=100,
            speckleRange=2,
            mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
        )
        return (
            matcher.compute(
                cv2.cvtColor(first, cv2.COLOR_RGB2GRAY),
                cv2.cvtColor(second, cv2.COLOR_RGB2GRAY),
            ).astype(np.float32)
            / 16
        )

    dl = match(a, b, minimum)
    dr = match(b, a, -minimum - disparities)
    yy, xx = np.indices(dl.shape)
    xr = np.rint(xx - dl).astype(int)
    valid = (xr >= 0) & (xr < dl.shape[1]) & (sign * dl > 1)
    valid &= np.abs(dl + dr[yy, np.clip(xr, 0, dl.shape[1] - 1)]) < 1.5
    if vertical:
        dl, valid = dl.T.copy(), valid.T.copy()
    rectified = cv2.reprojectImageTo3D(dl, q)
    z = rectified[..., 2]
    valid &= np.isfinite(z) & (z > 0) & (z < far_depth)
    # Exclude borders whose rectification samples outside either original image.
    border1 = cv2.remap(
        np.ones(left.shape[:2], np.uint8), *map1, cv2.INTER_NEAREST
    ).astype(bool)
    border2 = cv2.remap(
        np.ones(right.shape[:2], np.uint8), *map2, cv2.INTER_NEAREST
    ).astype(bool)
    valid &= border1
    right_coordinates = np.indices(dl.shape)
    if vertical:
        target_y = np.clip(
            np.rint(right_coordinates[0] - dl).astype(int), 0, dl.shape[0] - 1
        )
        valid &= border2[target_y, right_coordinates[1]]
    else:
        target_x = np.clip(
            np.rint(right_coordinates[1] - dl).astype(int), 0, dl.shape[1] - 1
        )
        valid &= border2[right_coordinates[0], target_x]
    rectified_pose = np.eye(4)
    rectified_pose[:3, :3] = r1 @ pose1[:3, :3]
    rectified_pose[:3, 3] = r1 @ pose1[:3, 3]
    color = cv2.remap(left, *map1, cv2.INTER_LINEAR)
    return depth_surface(z, color, p1[:3, :3], rectified_pose, valid)


def dense_surface(directory: Path, reconstruction, stage):
    dense = directory / "undistorted"
    undistort_options = pycolmap.UndistortCameraOptions()
    undistort_options.max_image_size = config.DENSE_SIZE
    stage("Preparing calibrated stereo views")
    pycolmap.undistort_images(
        dense,
        directory / "sparse",
        directory / "images",
        undistort_options=undistort_options,
        num_threads=config.THREADS,
    )
    calibrated = pycolmap.Reconstruction(dense / "sparse")
    images = sorted(
        (im for im in calibrated.images.values() if im.has_pose), key=lambda im: im.name
    )
    tracks = {
        im.image_id: {p.point3D_id for p in im.points2D if p.has_point3D()}
        for im in images
    }
    meshes, used = [], set()
    for index, im in enumerate(images):
        candidates = sorted(
            (other for other in images if other.image_id != im.image_id),
            key=lambda other: len(tracks[im.image_id] & tracks[other.image_id]),
            reverse=True,
        )
        for other in candidates[:2]:
            pair = tuple(sorted((im.image_id, other.image_id)))
            common = tracks[im.image_id] & tracks[other.image_id]
            if pair in used or len(common) < 30:
                continue
            used.add(pair)
            stage(f"Reconstructing visible surfaces: view {index + 1} of {len(images)}")
            first = np.array(Image.open(dense / "images" / im.name).convert("RGB"))
            second = np.array(Image.open(dense / "images" / other.name).convert("RGB"))
            c1, c2 = (
                calibrated.cameras[im.camera_id],
                calibrated.cameras[other.camera_id],
            )
            k1, k2 = c1.calibration_matrix(), c2.calibration_matrix()
            if first.shape != second.shape:
                scale = np.array(
                    [
                        first.shape[1] / second.shape[1],
                        first.shape[0] / second.shape[0],
                        1.0,
                    ]
                )
                k2 = np.diag(scale) @ k2
                second = cv2.resize(second, (first.shape[1], first.shape[0]))
            t1, t2 = np.eye(4), np.eye(4)
            t1[:3], t2[:3] = (
                im.cam_from_world().matrix(),
                other.cam_from_world().matrix(),
            )
            xyz = np.array([calibrated.points3D[point].xyz for point in common])
            depths = (xyz @ t1[:3, :3].T + t1[:3, 3])[:, 2]
            far_depth = float(np.quantile(depths[depths > 0], 0.98) * 1.5)
            mesh = stereo_pair(first, second, k1, k2, t1, t2, far_depth)
            if len(mesh.faces):
                meshes.append(mesh)
    return trimesh.util.concatenate(meshes) if meshes else trimesh.Trimesh()


def reconstruct(job_id: str):
    directory = store.job_dir(job_id)
    started = time.perf_counter()
    store.update_job(job_id, status="running", error=None)

    def stage(message):
        store.update_job(job_id, stage=message)

    try:
        job = store.get_job(job_id)
        stage("Decoding capture")
        frames = prepare_frames(directory, job["options"])
        if job["options"].get("engine") == "architecture":
            if not 4 <= len(frames) <= 12:
                raise ValueError(
                    "Structured architecture requires 4 to 12 source views."
                )
            store.update_job(
                job_id,
                status="awaiting_agent",
                stage="Ready for Codex modeling via MCP",
            )
            return
        if len(frames) == 1:
            from .monocular import reconstruct_photo

            scene = reconstruct_photo(directory, frames[0], stage)
        elif job["options"].get("engine", "mapanything") == "mapanything":
            from .multiview import reconstruct_multiview

            scene = reconstruct_multiview(
                directory, frames, stage, job["options"].get("calibration")
            )
        else:
            reconstruction, components = run_sfm(directory, job["options"], stage)
            scene, xyz, colors = sparse_scene(reconstruction)
            mesh = dense_surface(directory, reconstruction, stage)
            stage("Exporting geometry and localization index")
            from .localization import build_index

            build_index(directory, reconstruction)
            write_geometry(
                directory,
                mesh,
                mesh.vertices if len(mesh.vertices) else xyz,
                mesh.visual.vertex_colors[:, :3] if len(mesh.vertices) else colors,
            )
            scene |= {
                "mode": "multiview",
                "registered_frames": reconstruction.num_reg_images(),
                "total_frames": len(frames),
                "sparse_points": reconstruction.num_points3D(),
                "surface_vertices": len(mesh.vertices),
                "surface_triangles": len(mesh.faces),
                "reprojection_error_px": reconstruction.compute_mean_reprojection_error(),
                "components": components,
                "geometry_source": "COLMAP and calibrated stereo",
                "localizable": True,
                "scale_provenance": "Unknown monocular scale",
            }
        scene |= {
            "id": job_id,
            "name": job["name"],
            "frames": frames,
            "processing_seconds": round(time.perf_counter() - started, 2),
            "compute_device": (
                config.DEVICE if scene["mode"] == "multiview" else config.DEPTH_DEVICE
            ),
            "scale": job.get("scale"),
            "projection_label": "Camera-aligned projection, not a surveyed floor plan",
            "artifacts": [
                name
                for name in ["surface.glb", "points.ply"]
                if (directory / name).is_file()
            ],
        }
        store.atomic_json(directory / "scene.json", scene)
        store.update_job(
            job_id,
            status="ready",
            stage="Map ready",
            summary={
                key: scene[key]
                for key in [
                    "mode",
                    "registered_frames",
                    "total_frames",
                    "sparse_points",
                    "surface_triangles",
                    "processing_seconds",
                ]
            },
        )
    except Exception as error:
        # Job boundary: preserve uploads and mark failure instead of losing background exceptions.
        store.update_job(
            job_id,
            status="failed",
            stage="Reconstruction failed",
            error=str(error)[:600],
        )


def clear_derived(directory: Path):
    for name in ["images", "models", "sparse", "undistorted", "index", "predictions"]:
        shutil.rmtree(directory / name, ignore_errors=True)
    for name in [
        "database.db",
        "database.db-wal",
        "database.db-shm",
        "scene.json",
        "frames.json",
        "surface.glb",
        "points.ply",
    ]:
        (directory / name).unlink(missing_ok=True)

"""Local observed-photo appearance on fixed geometry, with CPU visibility checks."""

import hashlib

import cv2
import numpy as np
import open3d as o3d
import trimesh
from PIL import Image

from .. import store
from . import build_mesh
from .alignment import fit_photos


def projection_rejection(fit, max_error_px):
    if fit["check_count"] < 2:
        return "Needs at least two independently chosen excluded check landmarks."
    if max(fit["max_error_px"], fit["check_max_error_px"]) > max_error_px:
        return "Fit or excluded-check pixel error exceeds the appearance tolerance."
    return None


def bake_appearance(document, frames, images, output, max_error_px=4.0):
    fits = fit_photos(document, frames)
    if not fits:
        raise ValueError("Photo appearance requires at least one aligned source view.")
    original = build_mesh(document)
    meshes = list(original.geometry.values())
    combined = trimesh.util.concatenate(meshes)
    # CPU triangle visibility, no inference service or extra capture frames.
    rayscene = o3d.t.geometry.RaycastingScene()
    rayscene.add_triangles(
        o3d.core.Tensor(np.asarray(combined.vertices, dtype=np.float32)),
        o3d.core.Tensor(np.asarray(combined.faces, dtype=np.uint32)),
    )
    photo_materials = []
    projections = []
    rejected = [projection_rejection(f, max_error_px) for f in fits]
    for fit in fits:
        path = images / fit["source"]
        with Image.open(path) as photo:
            picture = photo.convert("RGB")
        photo_materials.append(
            trimesh.visual.material.PBRMaterial(
                baseColorTexture=picture,
                baseColorFactor=[255, 255, 255, 255],
                roughnessFactor=1,
                metallicFactor=0,
                doubleSided=True,
            )
        )
        pose = np.array(fit["world_to_camera"])
        projections.append(
            (
                cv2.Rodrigues(pose[:3, :3])[0],
                pose[:3, 3],
                np.array(fit["intrinsic"]),
                np.array(fit["distortion"]),
                np.linalg.inv(pose)[:3, 3],
            )
        )
    result = trimesh.Scene()
    totals = [0] * len(fits)
    covered_area = 0.0
    total_area = 0.0
    untouched = 0
    for name, mesh in original.geometry.items():
        triangles = mesh.triangles
        # ponytail: bounded barycentric samples, not exhaustive per-texel occlusion. Use an atlas baker if accepted views still show sub-face occluders.
        weights = np.array(
            [[i / 4, j / 4, 1 - (i + j) / 4] for i in range(5) for j in range(5 - i)]
        )
        samples = np.einsum("sk,fkj->fsj", weights, triangles)
        sample_count = len(weights)
        assignment = np.full(len(triangles), -1)
        best_score = 0.0
        uvs = []
        for camera_index, (r, t, k, d, center) in enumerate(projections):
            element_id = mesh.metadata["element_id"]
            supported = any(
                m["element_id"] == element_id and m["role"] == "check"
                for m in fits[camera_index]["matches"]
            )
            material = getattr(mesh.visual, "material", None)
            if (
                rejected[camera_index]
                or not supported
                or getattr(material, "alphaMode", "OPAQUE") == "BLEND"
            ):
                uvs.append(None)
                continue
            flat = samples.reshape(-1, 3)
            pixels = cv2.projectPoints(flat, r, t, k, d)[0].reshape(
                len(triangles), sample_count, 2
            )
            uv = pixels / np.array(fits[camera_index]["size"])
            corners = cv2.projectPoints(triangles.reshape(-1, 3), r, t, k, d)[
                0
            ].reshape(-1, 3, 2)
            uvs.append(corners / np.array(fits[camera_index]["size"]))
            affine = np.einsum("sk,fkj->fsj", weights, corners)
            interpolation_error = np.linalg.norm(pixels - affine, axis=2).max(axis=1)
            vectors = flat - center
            lengths = np.linalg.norm(vectors, axis=1)
            directions = vectors / np.maximum(lengths[:, None], 1e-10)
            rays = np.column_stack(
                [np.broadcast_to(center, vectors.shape), directions]
            ).astype(np.float32)
            hits = rayscene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            # Numerical surface tolerance only, not a physical uncertainty estimate.
            visibility = np.abs(hits - lengths) <= np.maximum(1e-4, lengths * 1e-5)
            depth = (flat @ cv2.Rodrigues(r)[0].T + t)[:, 2].reshape(-1, sample_count)
            visible = (
                visibility.reshape(-1, sample_count).all(axis=1)
                & (depth > 0).all(axis=1)
                & (
                    (pixels >= 1) & (pixels < np.array(fits[camera_index]["size"]) - 1)
                ).all(axis=(1, 2))
                & (interpolation_error <= 0.5)
            )
            facing = np.maximum(
                0,
                np.einsum(
                    "ij,ij->i",
                    mesh.face_normals,
                    -directions.reshape(-1, sample_count, 3).mean(axis=1),
                ),
            )
            a, b = corners[:, :, 0], corners[:, :, 1]
            area = (
                np.abs(
                    (a[:, 1] - a[:, 0]) * (b[:, 2] - b[:, 0])
                    - (a[:, 2] - a[:, 0]) * (b[:, 1] - b[:, 0])
                )
                / 2
            )
            chosen = visible & (facing > 0)
            score = float((area * facing * chosen).sum())
            if score > best_score:
                # One source per mesh part avoids alternating unrelated photo fragments.
                assignment[:] = -1
                assignment[chosen] = camera_index
                best_score = score
        for camera_index in [-1, *range(len(fits))]:
            selected = np.flatnonzero(assignment == camera_index)
            if not len(selected):
                continue
            if camera_index < 0:
                part = mesh.submesh([selected], append=True, repair=False)
                # trimesh.submesh drops texture materials without UV coordinates.
                if mesh.visual.kind == "texture" and mesh.visual.uv is None:
                    part.visual = trimesh.visual.TextureVisuals(
                        material=mesh.visual.material.copy()
                    )
                untouched += len(selected)
            else:
                part = trimesh.Trimesh(
                    vertices=triangles[selected].reshape(-1, 3),
                    faces=np.arange(len(selected) * 3).reshape(-1, 3),
                    vertex_normals=mesh.vertex_normals[mesh.faces[selected]].reshape(
                        -1, 3
                    ),
                    process=False,
                )
                uv = uvs[camera_index][selected].reshape(-1, 2).copy()
                uv[:, 1] = 1 - uv[:, 1]
                part.visual = trimesh.visual.TextureVisuals(
                    uv=uv, material=photo_materials[camera_index]
                )
                totals[camera_index] += len(selected)
                covered_area += float(mesh.area_faces[selected].sum())
            part.metadata = mesh.metadata | {
                "appearance_source": fits[camera_index]["source"]
                if camera_index >= 0
                else "original_material"
            }
            result.add_geometry(
                part,
                node_name=f"{name}__photo_{camera_index}",
                geom_name=f"{name}__photo_{camera_index}",
            )
        total_area += float(mesh.area)
    output.mkdir(parents=True, exist_ok=False)
    result.export(output / "photo-appearance.glb")
    report = {
        "method": "CPU visibility-tested source-photo projection; unchanged triangle coordinates",
        "source_images": [
            {
                "name": fit["source"],
                "sha256": hashlib.sha256(
                    (images / fit["source"]).read_bytes()
                ).hexdigest(),
                "textured_faces": count,
                "fit_rmse_px": fit["rmse_px"],
                "check_rmse_px": fit["check_rmse_px"],
                "projection_rejection": reason,
            }
            for fit, count, reason in zip(fits, totals, rejected)
        ],
        "unaligned_sources": [
            f["name"]
            for f in frames
            if f["name"] not in {fit["source"] for fit in fits}
        ],
        "surface_triangles": len(combined.faces),
        "original_material_faces": untouched,
        "photo_covered_area_fraction": covered_area / total_area if total_area else 0,
        "bytes": (output / "photo-appearance.glb").stat().st_size,
        "physically_verified": False,
        "promoted": False,
        "max_camera_error_px": max_error_px,
        "max_uv_interpolation_error_px": 0.5,
        "limits": "Appearance experiment only. Requires excluded source checks, including one on each textured element, and uses one source per part. Sampled visibility and a half-pixel UV interpolation bound reject unsupported triangles; they cannot exclude every sub-face occlusion. Captured lighting remains baked. Use explicit clean material swatches for repeated material appearance instead of relaxing alignment gates. Unobserved faces retain original materials.",
    }
    store.atomic_json(output / "comparison.json", report)
    return report

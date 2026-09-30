"""Agent-selected, hash-linked material samples. No label-to-material inference."""

import hashlib
import io
import json
from functools import lru_cache
from typing import Annotated, Literal

import cv2
import numpy as np
import trimesh
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import store

Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Length = Annotated[float, Field(gt=0, le=10000, allow_inf_nan=False)]
UV = tuple[Fraction, Fraction]


class PhotoMaterial(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    map_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source: str = Field(pattern=r"^[^/\\]{1,255}$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    quad: tuple[UV, UV, UV, UV] = Field(
        description="Clean planar material patch: top-left, top-right, bottom-right, bottom-left in full-image fractions. Exclude object boundaries, occluders, highlights and large shadows. No entire-room photograph."
    )
    repeat_m: tuple[Length, Length] = Field(
        description="Estimated width/height of the selected material patch in model metres; not physical measurement evidence."
    )
    targets: list[str] = Field(min_length=1, max_length=256)
    tiling: Literal["mirror", "repeat"] = "mirror"
    note: str = Field(
        min_length=1,
        max_length=2000,
        description="Why the sample represents these exact surfaces. Declare repeated appearance, estimated scale and any baked lighting.",
    )

    @model_validator(mode="after")
    def valid_quad(self):
        p = np.asarray(self.quad, dtype=np.float32)
        if not cv2.isContourConvex(p) or abs(cv2.contourArea(p)) < 1e-8:
            raise ValueError(
                "Material corners must form a nondegenerate convex quadrilateral in boundary order."
            )
        if len(set(self.targets)) != len(self.targets):
            raise ValueError("Material targets must be distinct geometry IDs.")
        return self


def source_bytes(spec):
    directory = store.job_dir(spec.map_id)
    frames = directory / "frames.json"
    if not frames.is_file() or spec.source not in {
        f["name"] for f in json.loads(frames.read_text())
    }:
        raise ValueError(
            "Material source must be a decoded photo in its declared capture."
        )
    path = directory / "images" / spec.source
    if not path.is_file():
        raise ValueError("Material source image is missing.")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != spec.sha256:
        raise ValueError(
            "Material source hash changed. Inspect the actual photo before reauthoring."
        )
    return data


@lru_cache(maxsize=8)
def rectified_patch(data, quad, repeat_m, tiling):
    with Image.open(io.BytesIO(data)) as photo:
        image = np.asarray(photo.convert("RGB"))
    points = np.array(quad, dtype=np.float32) * [image.shape[1] - 1, image.shape[0] - 1]
    # Use the shorter opposing edges so a distant edge is not upsampled into invented detail.
    width = min(
        np.linalg.norm(points[1] - points[0]), np.linalg.norm(points[2] - points[3])
    )
    height = min(
        np.linalg.norm(points[3] - points[0]), np.linalg.norm(points[2] - points[1])
    )
    if min(width, height) < 8:
        raise ValueError(
            "Material patch needs at least eight source pixels along each edge."
        )
    density = min(width / repeat_m[0], height / repeat_m[1], 512 / max(repeat_m))
    size = np.maximum(2, np.floor(np.array(repeat_m) * density).astype(int))
    destination = np.array(
        [[0, 0], [size[0] - 1, 0], size - 1, [0, size[1] - 1]], dtype=np.float32
    )
    homography = cv2.getPerspectiveTransform(points.astype(np.float32), destination)
    patch = Image.fromarray(
        cv2.warpPerspective(image, homography, tuple(size), flags=cv2.INTER_LINEAR)
    )
    if tiling == "repeat":
        return patch
    # Explicit reflected repetition gives matching tile borders without synthesized pixels.
    tile = Image.new("RGB", (patch.width * 2, patch.height * 2))
    tile.paste(patch, (0, 0))
    tile.paste(ImageOps.mirror(patch), (patch.width, 0))
    tile.paste(ImageOps.flip(patch), (0, patch.height))
    tile.paste(ImageOps.flip(ImageOps.mirror(patch)), (patch.width, patch.height))
    return tile


def material_image(spec):
    # Validate bytes even on a cache hit; stale evidence must not quietly survive mutation.
    return rectified_patch(source_bytes(spec), spec.quad, spec.repeat_m, spec.tiling)


def apply_photo_materials(scene, recipes, frames):
    assigned = set()
    for recipe in recipes:
        texture = material_image(recipe)
        for target in recipe.targets:
            if target in assigned or target not in scene.geometry:
                raise ValueError(
                    f"Material target {target} is missing or assigned twice."
                )
            assigned.add(target)
            mesh = scene.geometry[target]
            element_id = mesh.metadata["element_id"]
            frame = frames.get(element_id)
            if frame is None:
                raise ValueError(
                    f"Material target {target} has no supported local surface frame. Use a UV-textured imported GLB."
                )
            original = getattr(mesh.visual, "material", None)
            if original is None or getattr(original, "alphaMode", "OPAQUE") == "BLEND":
                raise ValueError(
                    "Photo material patches require an opaque PBR surface; preserve glazing/transparency in the imported material."
                )
            # Rotation-only local coordinates keep physical repeat scale and follow object movement.
            frame = frame.copy()
            frame[:3, :3] /= np.linalg.norm(frame[:3, :3], axis=0)
            local = trimesh.transform_points(mesh.vertices, np.linalg.inv(frame))
            local_normals = mesh.face_normals @ frame[:3, :3]
            axis = np.abs(local_normals).argmax(axis=1)
            uv = np.empty((len(mesh.faces), 3, 2))
            for normal, plane in enumerate(([2, 1], [0, 2], [0, 1])):
                mask = axis == normal
                uv[mask] = local[mesh.faces[mask]][:, :, plane]
            uv /= np.array(recipe.repeat_m) * (2 if recipe.tiling == "mirror" else 1)
            normals = mesh.vertex_normals[mesh.faces].reshape(-1, 3).copy()
            mesh.unmerge_vertices()
            mesh.vertex_normals = normals
            material = original.copy()
            material.baseColorFactor = [255, 255, 255, 255]
            material.baseColorTexture = texture
            # Existing UV-dependent maps no longer describe these UVs. Never invent replacements.
            for channel in (
                "normalTexture",
                "occlusionTexture",
                "metallicRoughnessTexture",
                "emissiveTexture",
            ):
                if getattr(material, channel, None) is not None:
                    raise ValueError(
                        "Target has auxiliary UV maps. Author a new compatible textured GLB instead of discarding them."
                    )
            mesh.visual = trimesh.visual.TextureVisuals(
                uv=uv.reshape(-1, 2), material=material
            )
            mesh.metadata["photo_material"] = recipe.name

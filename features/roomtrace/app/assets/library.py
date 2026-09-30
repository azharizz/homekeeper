"""GLB validation, normalization, immutable storage, and reference crops."""

import hashlib
import io
import json
import math
import os
import re
import struct
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from .. import config, store
from .schema import MAX_BYTES, MAX_TRIANGLES


def root():
    return config.DATA / "assets"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def checked_id(identifier):
    if not re.fullmatch(r"[0-9a-f]{64}", identifier):
        raise ValueError("Invalid asset identifier.")
    return identifier


def blob_path(identifier):
    return root() / "blobs" / (checked_id(identifier) + ".glb")


def put_blob(data):
    identifier = digest(data)
    target = blob_path(identifier)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        # Atomic rename keeps concurrent readers from seeing a partial blob.
        with tempfile.TemporaryDirectory(dir=target.parent) as directory:
            temporary = Path(directory) / "asset.glb"
            temporary.write_bytes(data)
            os.replace(temporary, target)
    return identifier


def read_asset(identifier):
    path = root() / "records" / (checked_id(identifier) + ".json")
    if not path.is_file():
        raise ValueError(
            "Asset not found. Import or create it before placing an instance."
        )
    record = json.loads(path.read_text())
    if digest(canonical(record)) != identifier:
        raise ValueError("Asset metadata failed its integrity check.")
    return {"id": identifier, **record}


def asset_file(identifier, original=False):
    record = read_asset(identifier)
    path = blob_path(record["source_sha256" if original else "model_sha256"])
    if not path.is_file() or digest(path.read_bytes()) != path.stem:
        raise ValueError("Asset bytes are missing or failed their integrity check.")
    return path


def source_image(region):
    directory = store.job_dir(region.map_id)
    frame_path = directory / "frames.json"
    if not frame_path.is_file():
        raise ValueError("Source capture is missing or not decoded.")
    frames = json.loads(frame_path.read_text())
    if region.source not in {frame["name"] for frame in frames}:
        raise ValueError("Asset evidence references an image outside its capture.")
    path = directory / "images" / region.source
    if not path.is_file():
        raise ValueError("The declared source image is missing from storage.")
    return path


def inspect_glb(data):
    """Restrict imports to the static embedded subset that our geometry pipeline preserves."""
    if not 28 <= len(data) <= MAX_BYTES:
        raise ValueError("GLB must be nonempty and at most 64 MiB.")
    magic, version, length, size, kind = struct.unpack_from("<4sIIII", data)
    if (
        magic != b"glTF"
        or version != 2
        or length != len(data)
        or kind != 0x4E4F534A
        or size > length - 20
    ):
        raise ValueError("Invalid GLB 2 container.")
    try:
        tree = json.loads(data[20 : 20 + size])
    except (ValueError, UnicodeError) as error:
        raise ValueError("GLB contains invalid JSON.") from error
    if not isinstance(tree, dict) or not tree.get("meshes"):
        raise ValueError("GLB must contain a mesh scene.")
    if tree.get("asset", {}).get("version") != "2.0":
        raise ValueError("Asset must declare glTF version 2.0.")
    if tree.get("animations") or tree.get("skins"):
        raise ValueError(
            "Use static meshes; bake animation and skinning before import."
        )
    if tree.get("extensionsUsed") or tree.get("extensionsRequired"):
        raise ValueError(
            "Use core glTF PBR without extensions or compression; retain the source file separately."
        )
    if any(
        item.get("uri") for item in tree.get("buffers", []) + tree.get("images", [])
    ):
        raise ValueError(
            "GLB resources must use embedded buffer views, not URI resources."
        )
    # Trimesh intentionally skips some unsupported display features. Reject them before decoding.
    pending = [tree]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if value.get("extensions"):
                raise ValueError(
                    "glTF extensions are not supported by the static asset contract."
                )
            pending.extend(child for key, child in value.items() if key != "extras")
        elif isinstance(value, list):
            pending.extend(value)
    for material in tree.get("materials", []):
        slots = {**material, **material.get("pbrMetallicRoughness", {})}
        for key, texture in slots.items():
            if key.endswith("Texture") and isinstance(texture, dict):
                if (
                    texture.get("texCoord", 0) != 0
                    or texture.get("scale", 1) != 1
                    or texture.get("strength", 1) != 1
                ):
                    raise ValueError(
                        "Bake nondefault UV channels, normal scale and occlusion strength before import."
                    )
                source = tree["textures"][texture["index"]]["source"]
                if not 0 <= source < len(tree.get("images", [])):
                    raise ValueError("Material references a missing embedded image.")
    for sampler in tree.get("samplers", []):
        if (
            sampler.get("wrapS", 10497) != 10497
            or sampler.get("wrapT", 10497) != 10497
            or sampler.get("magFilter", 9729) != 9729
            or sampler.get("minFilter", 9987) != 9987
        ):
            raise ValueError(
                "Bake nondefault texture sampling before import; this pipeline uses repeat and linear mip filtering."
            )
    binary_start = 20 + size
    binary_size, binary_kind = struct.unpack_from("<II", data, binary_start)
    if binary_kind != 0x004E4942 or binary_start + 8 + binary_size != len(data):
        raise ValueError("GLB needs one complete embedded binary chunk.")
    if (
        len(tree.get("buffers", [])) != 1
        or tree["buffers"][0]["byteLength"] > binary_size
    ):
        raise ValueError("GLB binary buffer length is invalid.")
    binary = memoryview(data)[binary_start + 8 :]
    for view in tree.get("bufferViews", []):
        offset = view.get("byteOffset", 0)
        if (
            view.get("buffer", 0) != 0
            or offset < 0
            or view["byteLength"] < 0
            or offset + view["byteLength"] > binary_size
        ):
            raise ValueError("GLB buffer view exceeds its embedded buffer.")
    texture_pixels = 0
    for image in tree.get("images", []):
        if image.get("mimeType") not in {"image/png", "image/jpeg"}:
            raise ValueError("Embed PNG or JPEG textures in GLB buffer views.")
        view = tree["bufferViews"][image["bufferView"]]
        offset = view.get("byteOffset", 0)
        with Image.open(
            io.BytesIO(binary[offset : offset + view["byteLength"]])
        ) as picture:
            texture_pixels += picture.width * picture.height
            if texture_pixels > 4096**2:
                raise ValueError(
                    "Texture budget exceeded: 16 megapixels total per asset."
                )
            picture.verify()
    nodes = tree.get("nodes", [])
    if len(nodes) > 4096:
        raise ValueError("Asset node budget exceeded.")
    parents = set()
    for node in nodes:
        if "skin" in node or node.get("weights"):
            raise ValueError("Bake skinning and morph weights before import.")
        for child in node.get("children", []):
            if child in parents or not 0 <= child < len(nodes):
                raise ValueError(
                    "GLB node graph must be a forest with valid single-parent nodes."
                )
            parents.add(child)
    visited = set()
    pending = [i for i in range(len(nodes)) if i not in parents]
    while pending:
        index = pending.pop()
        visited.add(index)
        pending.extend(nodes[index].get("children", []))
    if len(visited) != len(nodes):
        raise ValueError("GLB node graph contains a cycle.")
    for mesh in tree["meshes"]:
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4 or primitive.get("targets"):
                raise ValueError(
                    "Use static indexed triangles; bake morph targets before import."
                )
            if any(
                key.startswith("TEXCOORD_") and key != "TEXCOORD_0"
                for key in primitive.get("attributes", {})
            ):
                raise ValueError(
                    "Only the first UV set is supported; bake materials to TEXCOORD_0."
                )
    if any(
        accessor.get("count", 0) > 3 * MAX_TRIANGLES
        for accessor in tree.get("accessors", [])
    ):
        raise ValueError("GLB accessor exceeds the asset geometry budget.")
    return tree


def decode(data):
    try:
        inspect_glb(data)
        scene = trimesh.load_scene(
            io.BytesIO(data), file_type="glb", process=False, merge_primitives=False
        )
        parts = scene.dump()
        if (
            not parts
            or len(parts) > 128
            or any(not isinstance(part, trimesh.Trimesh) for part in parts)
        ):
            raise ValueError("Asset requires triangle meshes.")
        if sum(len(part.faces) for part in parts) > MAX_TRIANGLES:
            raise ValueError(
                "Asset exceeds 250,000 triangles after applying instances."
            )
        for part in parts:
            if (
                not len(part.faces)
                or not np.isfinite(part.vertices).all()
                or part.area <= 1e-12
            ):
                raise ValueError("Asset geometry is empty, nonfinite or degenerate.")
            if part.faces.min() < 0 or part.faces.max() >= len(part.vertices):
                raise ValueError("Asset triangle indices are invalid.")
        return parts
    except (
        KeyError,
        IndexError,
        TypeError,
        AttributeError,
        OSError,
        struct.error,
        Image.DecompressionBombError,
    ) as error:
        raise ValueError(
            "GLB could not be decoded as supported static geometry."
        ) from error


def import_asset(data, spec):
    if spec.previous_asset:
        read_asset(spec.previous_asset)
    sources = [
        region.model_dump()
        | {"image_sha256": digest(source_image(region).read_bytes())}
        for region in spec.sources
    ]
    parts = decode(data)
    transform = np.eye(4)
    if spec.up_axis == "z":
        transform = trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0])
    transform[:3, :3] *= spec.metres_per_unit
    for part in parts:
        part.apply_transform(transform)
    bounds = np.array([part.bounds for part in parts])
    lo, hi = bounds[:, 0].min(axis=0), bounds[:, 1].max(axis=0)
    dimensions = hi - lo
    if (dimensions < 1e-6).any() or dimensions.max() > 10000:
        raise ValueError("Asset needs nonzero XYZ extents within 10,000 metres.")
    origin = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    transform[:3, 3] = -origin
    scene = trimesh.Scene()
    for index, part in enumerate(parts):
        part.apply_translation(-origin)
        scene.add_geometry(part, node_name=f"part_{index}", geom_name=f"part_{index}")
    model = scene.export(file_type="glb")
    if len(model) > MAX_BYTES:
        raise ValueError("Normalized GLB exceeds 64 MiB.")
    record = {
        **spec.model_dump(),
        "sources": sources,
        "source_sha256": put_blob(data),
        "model_sha256": put_blob(model),
        "source_to_asset": transform.tolist(),
        "bounds": scene.bounds.tolist(),
        "dimensions": dimensions.tolist(),
        "triangles": sum(len(part.faces) for part in parts),
        "parts": len(parts),
        "bytes": len(model),
        "contract_version": 1,
        "origin": "base center; Y up; X/Z centered; uniform metres-per-unit conversion",
        "verification": "Geometry import only. Evidence and dimension_basis are author declarations, not independent accuracy checks.",
    }
    identifier = digest(canonical(record))
    path = root() / "records" / (identifier + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        store.atomic_json(path, record)
    return {"id": identifier, **record}


def linear_rgba(color, opacity=1):
    """sRGB hex UI/authoring color to glTF linear factors. Alpha is already linear."""
    rgb = np.array([int(color[i : i + 2], 16) for i in (1, 3, 5)]) / 255
    return np.r_[
        np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4), opacity
    ]


def create_mesh(body):
    scene = trimesh.Scene()
    for index, part in enumerate(body.parts):
        mesh = trimesh.Trimesh(vertices=part.vertices, faces=part.faces, process=False)
        mesh.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(
                name=part.name,
                baseColorFactor=linear_rgba(part.color, part.opacity),
                roughnessFactor=part.roughness,
                metallicFactor=part.metallic,
                alphaMode="BLEND" if part.opacity < 1 else "OPAQUE",
                doubleSided=True,
            )
        )
        scene.add_geometry(mesh, node_name=f"part_{index}", geom_name=f"part_{index}")
    return import_asset(scene.export(file_type="glb"), body.spec)


def search_assets(query="", offset=0, limit=12):
    terms = query.casefold().split()
    records = []
    for path in sorted((root() / "records").glob("*.json")):
        record = read_asset(path.stem)
        text = " ".join(
            str(record[key]) for key in ("id", "name", "description", "provenance")
        ).casefold()
        if all(term in text for term in terms):
            records.append(
                {
                    key: record[key]
                    for key in (
                        "id",
                        "name",
                        "description",
                        "dimensions",
                        "dimension_basis",
                        "triangles",
                        "bytes",
                        "previous_asset",
                    )
                }
            )
    # ponytail: metadata scan suits a local library; add an indexed store when measured library size warrants it.
    return {
        "items": records[offset : offset + limit],
        "total": len(records),
        "offset": offset,
        "limit": limit,
    }


@lru_cache(maxsize=4)
def _parts(data_root, identifier):
    # The data root belongs in the cache key when storage changes between runs.
    data = asset_file(identifier).read_bytes()
    parts = decode(data)
    return parts


def asset_parts(identifier):
    # Copies protect cached geometry/materials from instance transforms.
    return [part.copy() for part in _parts(str(root()), identifier)]


def crop_reference(region):
    with Image.open(source_image(region)) as source:
        source.load()
        box = region.box or (0, 0, 1, 1)
        left, top = (
            math.floor(box[0] * source.width),
            math.floor(box[1] * source.height),
        )
        right, bottom = (
            math.ceil(box[2] * source.width),
            math.ceil(box[3] * source.height),
        )
        crop = source.crop((left, top, right, bottom)).convert("RGB")
        crop.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        crop.save(output, format="JPEG", quality=95)
        return output.getvalue()

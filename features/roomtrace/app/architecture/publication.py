"""Object placement and atomic revision publication."""

import json
import shutil
from uuid import uuid4

import numpy as np
import trimesh
from pydantic import Field
from shapely.geometry import MultiPoint

from .. import assets, store
from .document import Architecture
from .schema import (
    AssetInstance,
    Box,
    Identifier,
    Number,
    Rail,
    Record,
    Slab,
    Solid,
    Stair,
    Wall,
)
from .mesh import (
    anchor_matrix,
    build_mesh,
    component_meshes,
    object_meshes,
    object_parts,
    slab_shape,
    surface_polygons,
)


class Placement(Record):
    expected_revision: int = Field(ge=1)
    element_id: Identifier
    translation: tuple[Number, Number, Number] = (0, 0, 0)
    yaw: Number = Field(
        default=0,
        description="Additional radians about world Y, around the assembly bounds center.",
    )


def move_object(document, placement):
    parts = object_parts(document, placement.element_id)
    if any(getattr(item, "attachment", None) for item in parts):
        raise ValueError(
            "Attached objects follow their host. Edit their host-local offsets in the architecture document."
        )
    if any(not isinstance(item, (Box, Solid, AssetInstance, Rail)) for item in parts):
        raise ValueError(
            "Placement controls move furniture and rails. Edit walls, slabs and stairs through the full architecture document."
        )
    meshes = object_meshes(document, placement.element_id)
    pivot = np.vstack([mesh.vertices for mesh in meshes])
    pivot = (pivot.min(axis=0) + pivot.max(axis=0)) / 2
    elevation = next(
        level.elevation for level in document.levels if level.id == parts[0].level
    )
    rotation = trimesh.transformations.rotation_matrix(placement.yaw, [0, 1, 0])[:3, :3]
    result = document.model_dump()
    ids = {item.id for item in parts}
    for item in result["elements"]:
        if item["id"] not in ids:
            continue
        for key in ("position",) if "position" in item else ("start", "end"):
            world = np.array(item[key]) + [0, elevation, 0]
            item[key] = (
                rotation @ (world - pivot)
                + pivot
                + placement.translation
                - np.array([0, elevation, 0])
            ).tolist()
        if "yaw" in item:
            item["yaw"] += placement.yaw
    return Architecture.model_validate(result)


def publish(job: dict, document: Architecture, expected_revision: int):
    from .alignment import fit_photos
    from .checks import inspect_geometry
    from .evidence import measurement_checks
    from .features import feature_catalog, dimension_report

    directory = store.job_dir(job["id"])
    frames = json.loads((directory / "frames.json").read_text())
    names = {frame["name"] for frame in frames}
    for element in document.elements:
        if not set(element.sources) <= names:
            raise ValueError(f"{element.id} references an image outside this capture.")
    if any(p.map_id != job["id"] for p in document.photo_materials):
        raise ValueError(
            "Photo materials must use this capture's source photos. Reinspect the new room instead of reusing another room's evidence."
        )
    mesh = build_mesh(document)
    components = component_meshes(document, mesh)
    levels = {item.id: item for item in document.levels}
    elements = {item.id: item for item in document.elements}
    alignments = fit_photos(document, frames)
    checks = inspect_geometry(document, components)
    measurements = measurement_checks(document)
    revision_id = uuid4().hex
    target = directory / "architecture" / revision_id
    target.mkdir(parents=True)
    try:
        mesh.export(target / "surface.glb")
        store.atomic_json(target / "architecture.json", document.model_dump())
        scene = {
            "id": job["id"],
            "name": job["name"],
            "mode": "architecture",
            "revision": expected_revision + 1,
            "artifact_revision": revision_id,
            "architecture": document.model_dump(),
            "assets": {
                identifier: {
                    key: value
                    for key, value in assets.read_asset(identifier).items()
                    if key != "authoring_source"
                }
                for identifier in sorted(
                    {
                        item.asset_id
                        for item in document.elements
                        if isinstance(item, AssetInstance)
                    }
                )
            },
            "frames": frames,
            "bounds": mesh.bounds.tolist(),
            "components": {
                name: {
                    "bounds": item.bounds.tolist(),
                    "footprint": list(
                        MultiPoint(item.vertices[:, [0, 2]]).convex_hull.exterior.coords
                    ),
                    "anchor_matrix": anchor_matrix(
                        elements[name], levels, elements
                    ).tolist()
                    if isinstance(
                        elements[name], (Wall, Slab, Box, Solid, AssetInstance, Stair)
                    )
                    else None,
                    "surfaces": [
                        {
                            "polygon": list(shape.exterior.coords),
                            "holes": [list(ring.coords) for ring in shape.interiors],
                        }
                        for shape in surface_polygons(
                            slab_shape(elements[name], elements)
                        )
                    ]
                    if isinstance(elements[name], Slab)
                    else None,
                }
                for name, item in components.items()
            },
            "artifacts": ["surface.glb", "architecture.json"],
            "localizable": False,
            "points": [],
            "colors": [],
            "cameras": [],
            "photo_alignments": alignments,
            "geometry_checks": checks,
            "measurement_checks": measurements,
            "features": feature_catalog(document),
            "dimensions": [dimension_report(document, d) for d in document.dimensions],
            "display_from_world": np.eye(4).tolist(),
            "scale": None,
            "geometry_source": "Codex-authored architecture from source images",
            "scale_provenance": "Estimated dimensions, not physically verified",
            "surface_triangles": sum(
                len(item.faces) for item in mesh.geometry.values()
            ),
            "total_frames": len(frames),
        }
        store.atomic_json(target / "scene.json", scene)
        return store.publish_revision(
            job["id"],
            expected_revision,
            revision_id,
            {
                "mode": "architecture",
                "total_frames": len(frames),
                "surface_triangles": scene["surface_triangles"],
            },
        )
    except (OSError, ValueError):
        # A failed export or conflicting edit preserves the previous model.
        shutil.rmtree(target)
        raise

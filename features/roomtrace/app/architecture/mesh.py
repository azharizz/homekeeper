"""Geometry construction and model-space measurements."""

import math
from functools import lru_cache

import numpy as np
import trimesh
from PIL import Image
from shapely.geometry import MultiPoint, Polygon
from shapely.ops import unary_union

from .. import assets
from ..photo_materials import apply_photo_materials
from .document import Architecture
from .schema import (
    AssetInstance,
    Box,
    Rail,
    Slab,
    Solid,
    Stair,
    Staircase,
    Wall,
    Zone,
)


def box(center, size, yaw=0):
    transform = trimesh.transformations.rotation_matrix(yaw, [0, 1, 0])
    transform[:3, 3] = center
    return trimesh.creation.box(extents=size, transform=transform)


def host_matrix(element, levels):
    matrix = np.eye(4)
    matrix[1, 3] = levels[element.level].elevation
    if isinstance(element, Wall):
        direction = np.array(element.end) - element.start
        matrix = trimesh.transformations.rotation_matrix(
            -math.atan2(direction[1], direction[0]), [0, 1, 0]
        )
        matrix[:3, 3] = [
            element.start[0],
            levels[element.level].elevation + element.bottom,
            element.start[1],
        ]
    elif isinstance(element, Slab):
        matrix[1, 3] += element.top
    return matrix


def component_matrix(element, levels, elements):
    matrix = (
        trimesh.transformations.rotation_matrix(element.yaw, [0, 1, 0])
        @ trimesh.transformations.rotation_matrix(element.pitch, [1, 0, 0])
        @ trimesh.transformations.rotation_matrix(element.roll, [0, 0, 1])
    )
    matrix[:3, 3] = element.position
    if element.attachment:
        host = elements[element.attachment.host]
        parent = host_matrix(host, levels)
        if element.attachment.opening:
            opening = next(
                o for o in host.openings if o.id == element.attachment.opening
            )
            parent = parent @ trimesh.transformations.translation_matrix(
                [
                    opening.offset + opening.width / 2,
                    opening.sill + opening.height / 2,
                    0,
                ]
            )
        return parent @ matrix
    matrix[1, 3] += levels[element.level].elevation
    return matrix


def anchor_matrix(element, levels, elements):
    if isinstance(element, AssetInstance):
        matrix = component_matrix(element, levels, elements)
        lo, hi = np.array(assets.read_asset(element.asset_id)["bounds"]) * element.scale
        origin, size = lo, hi - lo
    elif isinstance(element, (Box, Solid)):
        matrix = component_matrix(element, levels, elements)
        origin, size = -np.array(element.size) / 2, np.array(element.size)
    elif isinstance(element, Slab):
        x0, z0, x1, z1 = Polygon(element.polygon).bounds
        matrix = host_matrix(element, levels)
        origin, size = (
            [x0, -element.thickness, z0],
            [x1 - x0, element.thickness, z1 - z0],
        )
    else:
        along = np.array(element.end) - element.start
        matrix = trimesh.transformations.rotation_matrix(
            -math.atan2(along[1], along[0]), [0, 1, 0]
        )
        matrix[:3, 3] = [
            element.start[0],
            levels[element.level].elevation + getattr(element, "bottom", 0),
            element.start[1],
        ]
        height = (
            element.height
            if isinstance(element, Wall)
            else levels[element.to_level].elevation - levels[element.level].elevation
        )
        width = element.thickness if isinstance(element, Wall) else element.width
        origin, size = [0, 0, -width / 2], [np.linalg.norm(along), height, width]
    local = np.diag([*size, 1.0])
    local[:3, 3] = origin
    return matrix @ local


def stair_opening_polygon(stair):
    spec = stair.opening
    start, end = np.array(stair.start), np.array(stair.end)
    along = (end - start) / np.linalg.norm(end - start)
    across = np.array([-along[1], along[0]]) * (stair.width / 2 + spec.margin)
    a = start + (end - start) * spec.from_fraction - along * spec.margin
    b = start + (end - start) * spec.to_fraction + along * spec.margin
    return Polygon([a - across, b - across, b + across, a + across])


def slab_shape(slab, elements):
    shape = Polygon(slab.polygon, slab.holes)
    for stair in elements.values():
        if isinstance(stair, Staircase):
            for flight in stair.flights:
                if (
                    flight.opening
                    and flight.opening.slab == slab.id
                    and flight.opening.mode == "cut"
                ):
                    shape = shape.difference(stair_opening_polygon(flight))
        if (
            isinstance(stair, Stair)
            and stair.opening
            and stair.opening.slab == slab.id
            and stair.opening.mode == "cut"
        ):
            shape = shape.difference(stair_opening_polygon(stair))
    if shape.is_empty or shape.area < 1e-6:
        raise ValueError(f"Stair openings remove all of slab {slab.id}.")
    return shape


def surface_polygons(shape):
    return [shape] if shape.geom_type == "Polygon" else list(shape.geoms)


def mesh_element(element, levels, elements=None):
    elements = elements or {}
    elevation = levels[element.level].elevation
    if isinstance(element, Zone):
        return None
    if isinstance(element, Staircase):
        from .structure import staircase_mesh

        return staircase_mesh(element, levels)
    if isinstance(element, AssetInstance):
        # Measurements use geometry only; avoid creating texture atlases for diagnostic meshes.
        return trimesh.util.concatenate(
            [
                trimesh.Trimesh(vertices=part.vertices, faces=part.faces, process=False)
                for part in instance_meshes(element, levels, elements)
            ]
        )
    if isinstance(element, Rail):
        endpoints = np.array([element.start, element.end]) + [0, elevation, 0]
        return trimesh.creation.cylinder(
            radius=element.radius, segment=endpoints, sections=12
        )
    if isinstance(element, (Box, Solid)):
        if isinstance(element, Solid):
            if element.shape == "ellipsoid":
                mesh = trimesh.creation.icosphere(subdivisions=2)
                mesh.apply_scale(np.array(element.size) / 2)
            else:
                mesh = trimesh.creation.cylinder(radius=1, height=1, sections=32)
                mesh.apply_transform(
                    trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0])
                )
                mesh.apply_scale(
                    [element.size[0] / 2, element.size[1], element.size[2] / 2]
                )
        elif element.radius:
            # Rounded cuboid is the convex hull of spheres at its inset corners.
            sphere = trimesh.creation.uv_sphere(radius=element.radius, count=[8, 12])
            corners = trimesh.creation.box(
                extents=np.array(element.size) - 2 * element.radius
            ).vertices
            mesh = trimesh.convex.convex_hull(
                (corners[:, None, :] + sphere.vertices).reshape(-1, 3)
            )
        else:
            mesh = trimesh.creation.box(extents=element.size)
        # Local Z roll, then X pitch, then world Y yaw. Left multiplication preserves local tilt during group yaw.
        transform = component_matrix(element, levels, elements)
        mesh.apply_transform(transform)
        return mesh
    if isinstance(element, Slab):
        mesh = trimesh.util.concatenate(
            [
                trimesh.creation.extrude_polygon(
                    shape, element.thickness, engine="earcut"
                )
                for shape in surface_polygons(slab_shape(element, elements))
            ]
        )
        # Extrusion starts in XY with Z up. Rotate to Y up without changing plan Z.
        mesh.apply_transform(
            [
                [1, 0, 0, 0],
                [0, 0, -1, elevation + element.top],
                [0, 1, 0, 0],
                [0, 0, 0, 1],
            ]
        )
        return mesh
    start, end = np.array(element.start), np.array(element.end)
    length = np.linalg.norm(end - start)
    along = (end - start) / length
    yaw = -math.atan2(along[1], along[0])
    parts = []

    def segment(left, right, bottom, top, width):
        if right - left <= 1e-8 or top - bottom <= 1e-8:
            return
        if isinstance(element, Wall) and (element.start_joint or element.end_joint):
            from .structure import wall_footprint

            profile = wall_footprint(element, elements)
            across = np.array([-along[1], along[0]])
            # Clip the mitered profile only at interior opening breakpoints.
            extent = length + element.thickness + profile.length
            a = start + along * (left if left > 0 else -extent)
            b = start + along * (right if right < length - 1e-8 else extent)
            strip = Polygon(
                [
                    a - across * extent,
                    b - across * extent,
                    b + across * extent,
                    a + across * extent,
                ]
            )
            for shape in surface_polygons(profile.intersection(strip)):
                if shape.area <= 1e-10:
                    continue
                mesh = trimesh.creation.extrude_polygon(
                    shape, top - bottom, engine="earcut"
                )
                mesh.apply_transform(
                    [
                        [1, 0, 0, 0],
                        [0, 0, -1, elevation + top],
                        [0, 1, 0, 0],
                        [0, 0, 0, 1],
                    ]
                )
                parts.append(mesh)
            return
        center = start + along * (left + right) / 2
        parts.append(
            box(
                [center[0], elevation + (bottom + top) / 2, center[1]],
                [right - left, top - bottom, width],
                yaw,
            )
        )

    if isinstance(element, Wall):
        # Sweep horizontal breakpoints; subtract disjoint vertical opening intervals.
        cuts = sorted(
            {
                0.0,
                float(length),
                *(v for o in element.openings for v in (o.offset, o.offset + o.width)),
            }
        )
        for left, right in zip(cuts, cuts[1:]):
            mid = (left + right) / 2
            cursor = 0
            for opening in sorted(
                (o for o in element.openings if o.offset < mid < o.offset + o.width),
                key=lambda o: o.sill,
            ):
                segment(
                    left,
                    right,
                    element.bottom + cursor,
                    element.bottom + opening.sill,
                    element.thickness,
                )
                cursor = opening.sill + opening.height
            segment(
                left,
                right,
                element.bottom + cursor,
                element.bottom + element.height,
                element.thickness,
            )
    else:
        rise = levels[element.to_level].elevation - elevation
        for step in range(element.risers):
            top = (step + 1) * rise / element.risers
            segment(
                step * length / element.risers,
                (step + 1) * length / element.risers,
                0 if element.closed else top - element.tread_thickness,
                top,
                element.width,
            )
    if not parts:
        raise ValueError(f"{element.id} contains no solid material.")
    return trimesh.util.concatenate(parts)


@lru_cache(maxsize=4)
def finish_texture(finish):
    """Illustrative material finish selected by the author, never image inference."""
    y, x = np.mgrid[:256, :256] / 256
    noise = np.random.default_rng(0).uniform(-0.025, 0.025, x.shape)
    if finish == "brick":
        row = np.floor(y * 8)
        mortar = (np.mod(y * 8, 1) < 0.08) | (np.mod(x * 4 + row % 2 * 0.5, 1) < 0.035)
        value = np.where(mortar, 0.52, 0.88 + noise * 2)
    elif finish == "wood":
        grain = np.sin(2 * np.pi * (x * 30 + 0.2 * np.sin(y * 2 * np.pi)))
        value = 0.87 + 0.065 * grain + noise
        value[np.mod(x * 5, 1) < 0.018] = 0.52
    elif finish == "tile":
        joint = (np.mod(x * 8, 1) < 0.045) | (np.mod(y * 8, 1) < 0.045)
        value = np.where(joint, 0.62, 0.93 + noise)
    else:
        value = 0.9 + 0.035 * np.sin(x * 128 * np.pi) * np.sin(y * 128 * np.pi) + noise
    return Image.fromarray(
        np.repeat(np.uint8(np.clip(value, 0, 1) * 255)[:, :, None], 3, axis=2)
    )


def instance_meshes(element, levels, elements):
    parts = assets.asset_parts(element.asset_id)
    matrix = component_matrix(element, levels, elements)
    matrix[:3, :3] *= element.scale
    for mesh in parts:
        mesh.apply_transform(matrix)
    return parts


def component_meshes(document, scene=None):
    if scene is not None:
        # Reuse the exact exported geometry, without copying materials or building texture atlases.
        grouped = {}
        for mesh in scene.geometry.values():
            grouped.setdefault(mesh.metadata["element_id"], []).append(
                trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False)
            )
        return {
            identifier: trimesh.util.concatenate(parts)
            for identifier, parts in grouped.items()
        }
    levels = {item.id: item for item in document.levels}
    elements = {item.id: item for item in document.elements}
    return {
        item.id: mesh_element(item, levels, elements)
        for item in document.elements
        if not isinstance(item, Zone)
    }


def build_mesh(document: Architecture):
    levels = {level.id: level for level in document.levels}
    elements = {item.id: item for item in document.elements}
    scene = trimesh.Scene()
    triangles = 0
    for element in document.elements:
        if isinstance(element, AssetInstance):
            parts = instance_meshes(element, levels, elements)
            triangles += sum(len(part.faces) for part in parts)
            if triangles > assets.MAX_SCENE_TRIANGLES:
                raise ValueError(
                    "Scene exceeds 2,000,000 triangles. Reduce asset complexity or instances."
                )
            for index, part in enumerate(parts):
                name = f"{element.id}__asset_part_{index}"
                part.metadata = {
                    "element_id": element.id,
                    "asset_id": element.asset_id,
                    "level": element.level,
                    "kind": "asset",
                }
                scene.add_geometry(part, node_name=name, geom_name=name)
            continue
        mesh = mesh_element(element, levels, elements)
        if mesh is None:
            continue
        triangles += len(mesh.faces)
        if triangles > assets.MAX_SCENE_TRIANGLES:
            raise ValueError(
                "Scene exceeds 2,000,000 triangles. Reduce geometry complexity."
            )
        texture = None
        uv = None
        if element.finish != "plain":
            texture = finish_texture(element.finish)
            mesh.unmerge_vertices()
            normal_axis = np.repeat(np.abs(mesh.face_normals).argmax(axis=1), 3)
            uv = np.empty((len(mesh.vertices), 2))
            for axis, plane in enumerate(([2, 1], [0, 2], [0, 1])):
                mask = normal_axis == axis
                uv[mask] = mesh.vertices[mask][:, plane] / element.texture_scale
        mesh.visual = trimesh.visual.TextureVisuals(
            uv=uv,
            material=trimesh.visual.material.PBRMaterial(
                baseColorFactor=assets.linear_rgba(element.color, element.opacity),
                baseColorTexture=texture,
                roughnessFactor=element.roughness,
                metallicFactor=element.metallic,
                alphaMode="BLEND" if element.opacity < 1 else "OPAQUE",
                doubleSided=True,
            ),
        )
        mesh.metadata = {
            "element_id": element.id,
            "level": element.level,
            "kind": element.kind,
        }
        scene.add_geometry(mesh, node_name=element.id, geom_name=element.id)
    if not scene.geometry:
        raise ValueError(
            "The document must contain solid architecture, not only zones."
        )
    if document.photo_materials:
        frames = {
            e.id: anchor_matrix(e, levels, elements)
            for e in document.elements
            if isinstance(e, (Wall, Slab, Box, Solid, AssetInstance, Stair))
        }
        apply_photo_materials(scene, document.photo_materials, frames)
    scene.metadata = {"units": "estimated metres", "physically_verified": False}
    return scene


def object_parts(document, element_id):
    selected = next((item for item in document.elements if item.id == element_id), None)
    if selected is None:
        raise ValueError("Unknown component.")
    return [
        item
        for item in document.elements
        if item.id == element_id
        or (selected.assembly and item.assembly == selected.assembly)
    ]


def object_meshes(document, element_id):
    levels = {item.id: item for item in document.levels}
    elements = {item.id: item for item in document.elements}
    meshes = [
        mesh_element(item, levels, elements)
        for item in object_parts(document, element_id)
    ]
    meshes = [mesh for mesh in meshes if mesh is not None]
    if not meshes:
        raise ValueError("Select solid components to measure or move.")
    return meshes


def measure(document, first, second):
    meshes = [object_meshes(document, identifier) for identifier in (first, second)]
    bounds = [np.array([mesh.bounds for mesh in group]) for group in meshes]
    bounds = [
        np.array([group[:, 0].min(axis=0), group[:, 1].max(axis=0)]) for group in bounds
    ]
    plans = [
        unary_union(
            [MultiPoint(mesh.vertices[:, [0, 2]]).convex_hull for mesh in group]
        )
        for group in meshes
    ]
    return {
        "units": "estimated_metres",
        "bounds": [bound.tolist() for bound in bounds],
        "center_distance": float(
            np.linalg.norm(bounds[0].mean(axis=0) - bounds[1].mean(axis=0))
        ),
        "plan_gap": plans[0].distance(plans[1]),
        "plan_overlap_area": plans[0].intersection(plans[1]).area,
        "height_gap": float(
            max(0, bounds[0][0, 1] - bounds[1][1, 1], bounds[1][0, 1] - bounds[0][1, 1])
        ),
        "method": "Union of component convex plan hulls; overall height intervals. Conservative projections, not exact 3D collision or walking clearance.",
    }

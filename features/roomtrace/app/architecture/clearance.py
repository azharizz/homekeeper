"""Sample actual mesh sections, preserving height and nonconvex outlines."""

from itertools import combinations
import math
import numpy as np
import trimesh
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union

from . import (
    AssetInstance,
    Box,
    Solid,
    Staircase,
    Slab,
    Wall,
    host_matrix,
    slab_shape,
    stair_opening_polygon,
)
from .structure import stair_surfaces, cross_edge


def section(mesh, height):
    segments = trimesh.intersections.mesh_plane(mesh, [0, 1, 0], [0, height, 0])
    if not len(segments):
        return Polygon()
    segments = segments[:, :, [0, 2]]
    lines = [LineString(s) for s in segments if np.linalg.norm(s[0] - s[1]) > 1e-9]
    # Round only intersection arithmetic noise so triangle seams join in the planar graph.
    from shapely import set_precision

    graph = unary_union([set_precision(line, 1e-8) for line in lines])
    polygons = []
    for polygon in polygonize(graph):
        x, z = polygon.representative_point().coords[0]
        crossings = 0
        for (x0, z0), (x1, z1) in segments:
            if (z0 > z) != (z1 > z) and x < x0 + (z - z0) * (x1 - x0) / (z1 - z0):
                crossings += 1
        if crossings % 2:
            polygons.append(polygon)
    return unary_union(polygons)


def mesh_shells(mesh):
    """Separate welded shells so overlapping solids do not cancel by parity."""
    return trimesh.Trimesh(
        vertices=mesh.vertices, faces=mesh.faces, process=True
    ).split(only_watertight=False)


def placement_checks(document, meshes):
    elements = {e.id: e for e in document.elements}
    levels = {e.id: e for e in document.levels}
    objects = [
        e for e in document.elements if isinstance(e, (Box, Solid, AssetInstance))
    ]
    issues, parts = [], {}

    def shape(identifier, y):
        if identifier not in parts:
            # Per connected shell avoids canceling overlapping parts by even/odd parity.
            parts[identifier] = mesh_shells(meshes[identifier])
        return unary_union(
            [
                section(p, y)
                for p in parts[identifier]
                if p.bounds[0, 1] < y < p.bounds[1, 1]
            ]
        )

    # ponytail: pairwise AABB broad phase for at most 1000 authored elements; use a spatial index if profiling warrants it.
    for a, b in combinations(objects, 2):
        if a.assembly and a.assembly == b.assembly:
            continue
        lo = np.maximum(meshes[a.id].bounds[0], meshes[b.id].bounds[0])
        hi = np.minimum(meshes[a.id].bounds[1], meshes[b.id].bounds[1])
        if not (hi - lo > 1e-6).all():
            continue
        samples = []
        for fraction in (0.1, 0.5, 0.9):
            y = float(lo[1] + (hi[1] - lo[1]) * fraction)
            area = shape(a.id, y).intersection(shape(b.id, y)).area
            if area > 1e-6:
                samples.append({"height_m": y, "overlap_m2": area})
        if samples:
            issues.append(
                {
                    "code": "object_section_overlap",
                    "elements": [a.id, b.id],
                    "message": "Actual mesh sections overlap at the reported heights. Inspect object relationships.",
                    "samples": samples,
                }
            )
    for wall in (e for e in document.elements if isinstance(e, Wall)):
        transform = host_matrix(wall, levels)
        for opening in wall.openings:
            if not opening.swing:
                continue
            if opening.kind != "door":
                continue
            left, positive = (
                opening.swing.startswith("left"),
                opening.swing.endswith("positive"),
            )
            hinge = opening.offset if left else opening.offset + opening.width
            angles = np.linspace(0, math.radians(opening.swing_degrees), 49)
            local = [[hinge, 0, 0]] + [
                [
                    hinge + (1 if left else -1) * opening.width * math.cos(a),
                    0,
                    (1 if positive else -1) * opening.width * math.sin(a),
                ]
                for a in angles
            ]
            world = np.c_[local, np.ones(len(local))] @ transform.T
            sweep = Polygon(world[:, [0, 2]])
            base = levels[wall.level].elevation + wall.bottom + opening.sill
            for item in objects:
                if (
                    item.attachment
                    and item.attachment.host == wall.id
                    and item.attachment.opening == opening.id
                ):
                    continue
                low = max(base, meshes[item.id].bounds[0, 1])
                high = min(base + opening.height, meshes[item.id].bounds[1, 1])
                if high <= low:
                    continue
                areas = [
                    shape(item.id, float(low + (high - low) * t))
                    .intersection(sweep)
                    .area
                    for t in (0.1, 0.5, 0.9)
                ]
                if max(areas) > 1e-6:
                    issues.append(
                        {
                            "code": "door_swing_overlap",
                            "elements": [wall.id, item.id],
                            "opening": opening.id,
                            "message": "Mesh section intersects the authored door swing sector.",
                            "overlap_m2": max(areas),
                        }
                    )
    for stair in (e for e in document.elements if isinstance(e, Staircase)):
        surfaces = stair_surfaces(stair, levels)
        for flight in stair.flights:
            if not flight.opening:
                issues.append(
                    {
                        "code": "stair_opening_unlinked",
                        "elements": [stair.id],
                        "segment": flight.id,
                        "message": "Flight has no explicit overhead slab/opening relationship.",
                    }
                )
            else:
                slab = elements[flight.opening.slab]
                if (
                    flight.opening.mode == "cut"
                    and stair_opening_polygon(flight)
                    .intersection(Polygon(slab.polygon))
                    .area
                    < 1e-6
                ):
                    issues.append(
                        {
                            "code": "stair_opening_misses_slab",
                            "elements": [stair.id, slab.id],
                            "segment": flight.id,
                            "message": "Flight-derived opening misses its linked slab.",
                        }
                    )
                if (
                    abs(
                        levels[slab.level].elevation
                        + slab.top
                        - levels[stair.to_level].elevation
                    )
                    > 1e-6
                ):
                    issues.append(
                        {
                            "code": "stair_destination_height",
                            "elements": [stair.id, slab.id],
                            "message": "Destination slab top differs from the declared stair destination.",
                        }
                    )
        for (aid, a, atop, abottom), (bid, b, btop, bbottom) in combinations(
            surfaces, 2
        ):
            if (
                aid != bid
                and min(atop, btop) - max(abottom, bbottom) > 1e-6
                and a.intersection(b).area > 1e-6
            ):
                finding = {
                    "code": "stair_segment_intersection",
                    "elements": [stair.id],
                    "segments": sorted([aid, bid]),
                    "message": "Connected stair segments occupy overlapping model volume.",
                }
                if finding not in issues:
                    issues.append(finding)
        for slab in (e for e in document.elements if isinstance(e, Slab)):
            shape_slab = slab_shape(slab, elements)
            top = levels[slab.level].elevation + slab.top
            gaps = [
                (identifier, top - slab.thickness - y)
                for identifier, p, y, _ in surfaces
                if top > y - 1e-6 and p.intersection(shape_slab).area > 1e-6
            ]
            if gaps:
                identifier, gap = min(gaps, key=lambda v: v[1])
                issues.append(
                    {
                        "code": "stair_slab_intersection"
                        if gap < 0
                        else "stair_overhead_gap",
                        "elements": [stair.id, slab.id],
                        "segment": identifier,
                        "minimum_gap_m": gap,
                        "message": "Inspect the minimum tread/landing to overhead slab gap.",
                    }
                )
        flight = stair.flights[-1]
        end = np.array(cross_edge(flight, "end").coords)
        along = np.array(flight.end) - flight.start
        along = along / np.linalg.norm(along) * 0.02
        support_strip = Polygon([end[0], end[1], end[1] + along, end[0] + along])
        supports = unary_union(
            [
                slab_shape(s, elements)
                for s in document.elements
                if isinstance(s, Slab)
                and s.level == stair.to_level
                and abs(
                    levels[s.level].elevation + s.top - levels[stair.to_level].elevation
                )
                < 1e-6
            ]
        )
        if support_strip.difference(supports).area > 1e-6:
            issues.append(
                {
                    "code": "stair_landing_unsupported",
                    "elements": [stair.id],
                    "message": "Destination slab does not support the full final flight edge.",
                }
            )
    return issues

"""Targeted model consistency diagnostics. No layout inference or route decisions."""

import numpy as np
from shapely.geometry import MultiPoint, Polygon

from . import (
    AssetInstance,
    Box,
    Slab,
    Solid,
    Stair,
    Wall,
    host_matrix,
    mesh_element,
    slab_shape,
    stair_opening_polygon,
)


def inspect_geometry(document, meshes=None):
    elements = {item.id: item for item in document.elements}
    levels = {item.id: item for item in document.levels}
    meshes = meshes or {
        item.id: mesh_element(item, levels, elements) for item in document.elements
    }
    issues = []

    def issue(code, ids, message, **quantities):
        issues.append(dict(code=code, elements=ids, message=message, **quantities))

    for item in document.elements:
        mesh = meshes.get(item.id)
        attachment = getattr(item, "attachment", None)
        if attachment:
            host = elements[attachment.host]
            vertices = mesh.vertices
            if isinstance(host, Slab):
                top = levels[host.level].elevation + host.top
                gap = float(mesh.bounds[0, 1] - top)
                shape = slab_shape(host, elements)
                footprint = MultiPoint(vertices[:, [0, 2]]).convex_hull
                outside = footprint.difference(shape).area
                if abs(gap) > 0.005:
                    issue(
                        "slab_attachment_height",
                        [item.id, host.id],
                        "Attached object does not rest on the host slab top.",
                        gap_m=gap,
                    )
                if outside > 1e-6:
                    issue(
                        "slab_attachment_outside",
                        [item.id, host.id],
                        "Attached object projects outside the remaining slab surface.",
                        outside_area_m2=float(outside),
                    )
            else:
                local = (
                    np.c_[vertices, np.ones(len(vertices))]
                    @ np.linalg.inv(host_matrix(host, levels)).T
                )
                length = np.linalg.norm(np.array(host.end) - host.start)
                if (
                    local[:, 0].min() < -0.005
                    or local[:, 0].max() > length + 0.005
                    or local[:, 1].min() < -0.005
                    or local[:, 1].max() > host.height + 0.005
                ):
                    issue(
                        "wall_attachment_outside",
                        [item.id, host.id],
                        "Attached geometry extends beyond its host wall's length or height.",
                    )
        if isinstance(item, Stair):
            if item.opening is None:
                issue(
                    "stair_opening_unlinked",
                    [item.id],
                    "Stair has no explicit destination slab/opening link; overhead continuity is unverified.",
                )
            else:
                slab = elements[item.opening.slab]
                cut = stair_opening_polygon(item)
                if (
                    item.opening.mode == "cut"
                    and cut.intersection(Polygon(slab.polygon)).area < 1e-6
                ):
                    issue(
                        "stair_opening_misses_slab",
                        [item.id, slab.id],
                        "Linked opening does not intersect its destination slab.",
                    )
                if (
                    abs(
                        levels[slab.level].elevation
                        + slab.top
                        - levels[item.to_level].elevation
                    )
                    > 0.005
                ):
                    issue(
                        "stair_destination_height",
                        [item.id, slab.id],
                        "Stair top and destination slab top differ.",
                    )
            # Evaluate actual tread footprints against overhead slabs, retaining measured model gaps.
            start, end = np.array(item.start), np.array(item.end)
            along = (end - start) / np.linalg.norm(end - start)
            across = np.array([-along[1], along[0]]) * item.width / 2
            bottom = levels[item.level].elevation
            rise = levels[item.to_level].elevation - bottom
            for slab in (e for e in document.elements if isinstance(e, Slab)):
                slab_top = levels[slab.level].elevation + slab.top
                if slab_top <= bottom + 1e-6:
                    continue
                shape = slab_shape(slab, elements)
                gaps = []
                for step in range(item.risers):
                    a = start + (end - start) * step / item.risers
                    b = start + (end - start) * (step + 1) / item.risers
                    if (
                        Polygon([a - across, b - across, b + across, a + across])
                        .intersection(shape)
                        .area
                        > 1e-6
                    ):
                        gaps.append(
                            slab_top
                            - slab.thickness
                            - (bottom + (step + 1) * rise / item.risers)
                        )
                if gaps:
                    gap = float(min(gaps))
                    issue(
                        "stair_slab_intersection" if gap < 0 else "stair_overhead_gap",
                        [item.id, slab.id],
                        "Slab intersects stair treads."
                        if gap < 0
                        else "Overhead slab remains above part of the stair; inspect this model gap.",
                        minimum_gap_m=gap,
                    )
            destination = [
                s
                for s in document.elements
                if isinstance(s, Slab)
                and s.level == item.to_level
                and (item.opening is None or s.id == item.opening.slab)
            ]
            unsupported = Polygon(
                [
                    end - across,
                    end + along * 0.02 - across,
                    end + along * 0.02 + across,
                    end + across,
                ]
            )
            for slab in destination:
                unsupported = unsupported.difference(slab_shape(slab, elements))
            if unsupported.area > 1e-6:
                issue(
                    "stair_landing_unsupported",
                    [item.id] + ([item.opening.slab] if item.opening else []),
                    "Linked destination surface does not support the full stair width immediately beyond its endpoint.",
                    unsupported_area_m2=float(unsupported.area),
                )

    # Door aperture prism only. No arbitrary human clearance radius or automatic repositioning.
    for wall in (e for e in document.elements if isinstance(e, Wall)):
        inverse = np.linalg.inv(host_matrix(wall, levels))
        for index, opening in enumerate(wall.openings):
            if opening.kind not in {"door", "passage"}:
                continue
            for item in (
                e
                for e in document.elements
                if isinstance(e, (Box, Solid, AssetInstance))
            ):
                if (
                    item.attachment
                    and item.attachment.host == wall.id
                    and opening.id is not None
                    and item.attachment.opening == opening.id
                ):
                    continue
                local = (
                    np.c_[
                        meshes[item.id].vertices, np.ones(len(meshes[item.id].vertices))
                    ]
                    @ inverse.T
                )
                lo, hi = local[:, :3].min(axis=0), local[:, :3].max(axis=0)
                overlap = np.minimum(
                    hi,
                    [
                        opening.offset + opening.width,
                        opening.sill + opening.height,
                        wall.thickness / 2,
                    ],
                ) - np.maximum(lo, [opening.offset, opening.sill, -wall.thickness / 2])
                if (overlap > 1e-5).all():
                    issue(
                        "door_aperture_overlap",
                        [wall.id, item.id],
                        "Component bounds overlap a doorway aperture. Inspect actual surfaces before deciding it is blocked.",
                        opening=opening.id or str(index),
                    )
    from .clearance import placement_checks

    issues.extend(placement_checks(document, meshes))
    return {
        "issues": issues,
        "issue_count": len(issues),
        "units": "estimated_metres",
        "method": "Attachments, stair treads/landings, doorway prisms and authored single-leaf swings. Object overlap samples actual mesh sections at 10%, 50%, 90% of shared height. Thin collisions between samples and open/nonmanifold meshes may be missed. Absence of findings never proves clearance or a safe route.",
    }

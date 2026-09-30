"""Observed wall topology, explicit stair chains and reviewable structural edits."""

import math
from itertools import combinations

import numpy as np
import trimesh
from pydantic import Field
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union

from . import (
    Architecture,
    Identifier,
    Number,
    Positive,
    Record,
    Wall,
    host_matrix,
    mesh_element,
)
from .features import (
    dimension_report,
    feature_catalog,
    resolve_anchor,
    features,
)


def cross_edge(flight, endpoint):
    delta = np.array(flight.end) - flight.start
    across = np.array([-delta[1], delta[0]]) / np.linalg.norm(delta) * flight.width / 2
    p = np.array(getattr(flight, endpoint))
    return LineString([p - across, p + across])


def validate_staircase(stair):
    if len(stair.landings) != len(stair.flights) - 1:
        raise ValueError("Every pair of connected flights needs one landing.")
    ids = [part.id for part in [*stair.flights, *stair.landings]]
    if len(set(ids)) != len(ids):
        raise ValueError("Stair flight and landing IDs must be unique.")
    for flight in stair.flights:
        if (
            math.dist(flight.start, flight.end) < 0.001
            or stair.tread_thickness > flight.rise / flight.risers
        ):
            raise ValueError(
                "Flights need a nonzero run and tread thickness no greater than riser height."
            )
    for before, landing, after in zip(stair.flights, stair.landings, stair.flights[1:]):
        shape = Polygon(landing.polygon)
        if not shape.is_valid or shape.area < 1e-6:
            raise ValueError("Landing must be a valid polygon with positive area.")
        for flight, endpoint in ((before, "end"), (after, "start")):
            edge = cross_edge(flight, endpoint)
            if edge.difference(shape.boundary.buffer(1e-7)).length > 1e-6:
                raise ValueError(
                    "Landing boundary must support the full width of both connected flight endpoints."
                )
            delta = np.array(flight.end) - flight.start
            outside = np.array(getattr(flight, endpoint)) + delta / np.linalg.norm(
                delta
            ) * (1e-4 if endpoint == "end" else -1e-4)
            if not shape.covers(Point(outside)):
                raise ValueError(
                    "Landing must extend beyond the arriving flight and behind the departing flight."
                )


def stair_surfaces(stair, levels):
    """Exact horizontal tread/landing polygons and top heights."""
    y = levels[stair.level].elevation
    flights = stair.flights
    result = []
    for index, flight in enumerate(flights):
        start, end = np.array(flight.start), np.array(flight.end)
        left, right = np.array(cross_edge(flight, "start").coords)
        across = (right - left) / 2
        for step in range(flight.risers):
            a, b = (
                start + (end - start) * step / flight.risers,
                start + (end - start) * (step + 1) / flight.risers,
            )
            top = y + (step + 1) * flight.rise / flight.risers
            result.append(
                (
                    flight.id,
                    Polygon([a - across, b - across, b + across, a + across]),
                    top,
                    y if stair.closed else top - stair.tread_thickness,
                )
            )
        y += flight.rise
        if index < len(stair.landings):
            landing = stair.landings[index]
            result.append(
                (landing.id, Polygon(landing.polygon), y, y - landing.thickness)
            )
    return result


def staircase_mesh(stair, levels):
    parts = []
    for _, shape, top, bottom in stair_surfaces(stair, levels):
        mesh = trimesh.creation.extrude_polygon(shape, top - bottom, engine="earcut")
        mesh.apply_transform(
            [[1, 0, 0, 0], [0, 0, -1, top], [0, 1, 0, 0], [0, 0, 0, 1]]
        )
        parts.append(mesh)
    return trimesh.util.concatenate(parts)


def opening_guides(document):
    result = []
    for wall in (e for e in document.elements if isinstance(e, Wall)):
        length = math.dist(wall.start, wall.end)
        for opening in wall.openings:
            result.append(
                {
                    "wall": wall.id,
                    "opening": opening.id,
                    "sill_m": opening.sill,
                    "head_m": opening.sill + opening.height,
                    "head_clearance_m": wall.height - opening.sill - opening.height,
                    "start_gap_m": opening.offset,
                    "end_gap_m": length - opening.offset - opening.width,
                }
            )
        for a, b in combinations(wall.openings, 2):
            left, right = sorted((a, b), key=lambda o: o.offset)
            low, high = sorted((a, b), key=lambda o: o.sill)
            result.append(
                {
                    "wall": wall.id,
                    "openings": [a.id, b.id],
                    "horizontal_gap_m": right.offset - left.offset - left.width,
                    "vertical_gap_m": high.sill - low.sill - low.height,
                    "sill_delta_m": b.sill - a.sill,
                    "head_delta_m": b.sill + b.height - a.sill - a.height,
                    "left_delta_m": b.offset - a.offset,
                    "right_delta_m": b.offset + b.width - a.offset - a.width,
                }
            )
    return result


def wall_topology(document):
    result = []
    for level in document.levels:
        walls = [
            e for e in document.elements if isinstance(e, Wall) and e.level == level.id
        ]
        lines = {e.id: LineString([e.start, e.end]) for e in walls}
        intersections, ends = [], []
        for a, b in combinations(walls, 2):
            hit = lines[a.id].intersection(lines[b.id])
            if not hit.is_empty:
                intersections.append(
                    {
                        "walls": [a.id, b.id],
                        "kind": hit.geom_type,
                        "coordinates": list(hit.coords),
                        "shared_joint": bool(
                            {a.start_joint, a.end_joint}
                            & {b.start_joint, b.end_joint} - {None}
                        ),
                    }
                )
        for wall in walls:
            for endpoint in ("start", "end"):
                point = Point(getattr(wall, endpoint))
                others = [
                    (line.distance(point), identifier)
                    for identifier, line in lines.items()
                    if identifier != wall.id
                ]
                if not others or min(others)[0] > 1e-8:
                    gap, nearest = min(others) if others else (None, None)
                    ends.append(
                        {
                            "wall": wall.id,
                            "endpoint": endpoint,
                            "nearest_wall": nearest,
                            "gap_m": gap,
                        }
                    )
        merged = unary_union(list(lines.values()))
        observed = [
            {
                "polygon": list(p.exterior.coords),
                "holes": [list(h.coords) for h in p.interiors],
                "centerline_area_m2": p.area,
            }
            for p in polygonize(merged)
        ]
        result.append(
            {
                "level": level.id,
                "intersections": intersections,
                "unconnected_endpoints": ends,
                "closed_boundaries": observed,
            }
        )
    return result


def wall_footprint(wall, elements):
    """Miter a declared two-wall joint by intersecting its offset face lines."""
    delta = np.array(wall.end) - wall.start
    along = delta / np.linalg.norm(delta)
    normal = np.array([-along[1], along[0]]) * wall.thickness / 2
    corners = [
        np.array(wall.start) - normal,
        np.array(wall.end) - normal,
        np.array(wall.end) + normal,
        np.array(wall.start) + normal,
    ]
    for endpoint in ("start", "end"):
        joint = getattr(wall, endpoint + "_joint")
        if not joint:
            continue
        neighbors = [
            (e, end)
            for e in elements.values()
            if isinstance(e, Wall) and e.id != wall.id
            for end in ("start", "end")
            if getattr(e, end + "_joint") == joint
        ]
        if len(neighbors) != 1:
            continue  # Branch junctions retain intersecting wall solids; never infer a preferred continuation.
        other, other_end = neighbors[0]
        a = along * (1 if endpoint == "start" else -1)
        b = np.array(other.end) - other.start
        b = b / np.linalg.norm(b) * (1 if other_end == "start" else -1)
        matrix = np.column_stack((a, -b))
        if abs(np.linalg.det(matrix)) < 1e-8:
            continue
        na = np.array([-a[1], a[0]]) * wall.thickness / 2
        nb = np.array([-b[1], b[0]]) * other.thickness / 2
        distance = np.linalg.solve(matrix, -nb - na)[0]
        offset = na + a * distance
        if np.linalg.norm(offset) >= min(
            np.linalg.norm(delta), math.dist(other.start, other.end)
        ):
            raise ValueError(
                f"Joint {joint} miter extends beyond a wall. Author a bevel or split the corner explicitly."
            )
        p = np.array(getattr(wall, endpoint))
        if endpoint == "start":
            corners[0], corners[3] = p - offset, p + offset
        else:
            corners[1], corners[2] = p + offset, p - offset
    shape = Polygon(corners)
    if not shape.is_valid or shape.area <= 0:
        raise ValueError(f"Wall {wall.id} joint produces an invalid footprint.")
    return shape


def structure_report(document):
    return {
        "features": feature_catalog(document),
        "dimensions": [dimension_report(document, d) for d in document.dimensions],
        "openings": opening_guides(document),
        "topology": wall_topology(document),
        "units": "estimated_metres",
        "limits": "Closed boundaries follow authored wall centerlines only. Gaps remain open. Face distances exclude finish layers unless thickness includes them. All lengths are model estimates, not measured walking clearance.",
    }


class StructureEdit(Record):
    expected_revision: int = Field(ge=1)
    operation: str = Field(pattern="^(split_wall|move_joint|align_openings)$")
    wall_id: Identifier | None = None
    offset: Positive | None = None
    new_wall_id: Identifier | None = None
    joint_id: Identifier | None = None
    position: tuple[Number, Number] | None = None
    opening_id: Identifier | None = None
    target_opening_id: Identifier | None = None
    alignment: str | None = Field(default=None, pattern="^(sill|head|left|right)$")


def document_anchors(raw):
    for alignment in raw["alignments"]:
        yield from alignment["matches"]
    for item in [*raw["measurements"], *raw["dimensions"]]:
        yield item["start"]
        yield item["end"]


def propose_structure(document, request):
    raw = document.model_dump()
    elements = {e["id"]: e for e in raw["elements"]}
    wall = elements.get(request.wall_id)
    if request.operation == "move_joint":
        members = [
            (e, end)
            for e in raw["elements"]
            if e["kind"] == "wall"
            for end in ("start", "end")
            if request.joint_id and e[end + "_joint"] == request.joint_id
        ]
        if not members or request.position is None:
            raise ValueError("Choose an existing joint and explicit plan position.")
        for e, end in members:
            e[end] = request.position
    elif not wall or wall["kind"] != "wall":
        raise ValueError("Choose an existing wall.")
    elif request.operation == "align_openings":
        opening = next(
            (
                o
                for o in wall["openings"]
                if request.opening_id and o["id"] == request.opening_id
            ),
            None,
        )
        target = next(
            (
                o
                for o in wall["openings"]
                if request.target_opening_id and o["id"] == request.target_opening_id
            ),
            None,
        )
        if not opening or not target or opening is target or not request.alignment:
            raise ValueError(
                "Choose distinct stable opening IDs on one wall and an alignment."
            )
        field = "sill" if request.alignment in {"sill", "head"} else "offset"
        size = "height" if field == "sill" else "width"
        opening[field] = target[field] + (
            target[size] - opening[size]
            if request.alignment in {"head", "right"}
            else 0
        )
    else:
        if (
            not request.new_wall_id
            or request.new_wall_id in elements
            or not request.offset
        ):
            raise ValueError("A wall split needs an unused wall ID and an offset.")
        length = math.dist(wall["start"], wall["end"])
        cut = request.offset
        if not 0 < cut < length:
            raise ValueError("Split must lie strictly inside the wall.")
        if any(o["offset"] < cut < o["offset"] + o["width"] for o in wall["openings"]):
            raise ValueError("Cannot split through an opening.")
        if any(wall["id"] in p["targets"] for p in raw["photo_materials"]):
            raise ValueError(
                "Re-author this wall's photo-material targets before splitting it."
            )
        import copy

        second = copy.deepcopy(wall)
        second["id"] = request.new_wall_id
        middle = (
            np.array(wall["start"])
            + (np.array(wall["end"]) - wall["start"]) * cut / length
        ).tolist()
        joint = request.joint_id or request.new_wall_id
        if any(
            e.get(k) == joint
            for e in raw["elements"]
            for k in ("start_joint", "end_joint")
        ):
            raise ValueError("Split joint ID must be unused.")
        wall["end"], second["start"] = middle, middle
        wall["end_joint"], second["start_joint"] = joint, joint
        second["openings"] = [o for o in second["openings"] if o["offset"] >= cut]
        moved_openings = {o["id"] for o in second["openings"] if o["id"]}
        for o in second["openings"]:
            o["offset"] -= cut
        wall["openings"] = [o for o in wall["openings"] if o["offset"] < cut]
        old_elements = {e.id: e for e in document.elements}
        levels = {e.id: e for e in document.levels}
        inverse = np.linalg.inv(host_matrix(old_elements[wall["id"]], levels))
        for e in raw["elements"]:
            attachment = e.get("attachment")
            if not attachment or attachment["host"] != wall["id"]:
                continue
            vertices = mesh_element(
                old_elements[e["id"]], levels, old_elements
            ).vertices
            local = np.c_[vertices, np.ones(len(vertices))] @ inverse.T
            if local[:, 0].min() < cut - 1e-8 and local[:, 0].max() > cut + 1e-8:
                raise ValueError(f"Split crosses attached geometry {e['id']}.")
            if attachment.get("opening") in moved_openings or (
                not attachment.get("opening") and e["position"][0] >= cut
            ):
                attachment["host"] = second["id"]
                if not attachment.get("opening"):
                    e["position"][0] -= cut
        from . import Component
        from pydantic import TypeAdapter

        proposed_elements = TypeAdapter(list[Component]).validate_python(
            [*raw["elements"], second]
        )
        draft = document.model_copy(update={"elements": proposed_elements})
        for point in document_anchors(raw):
            if point["element_id"] != wall["id"]:
                continue
            feature = point.get("feature")
            if feature and feature["id"].startswith("opening:"):
                if feature["id"].split(":")[1] in moved_openings:
                    point["element_id"] = second["id"]
            elif feature and feature["id"].startswith("wall:end:"):
                point["element_id"] = second["id"]
            elif feature and feature["id"].startswith("wall:start:"):
                continue
            else:
                if feature:
                    from . import ModelAnchor

                    old_world = resolve_anchor(
                        document,
                        ModelAnchor.model_validate(
                            {k: point[k] for k in ("element_id", "anchor", "feature")}
                        ),
                    )
                    local_x = (inverse @ [*old_world, 1])[0]
                else:
                    local_x = point["anchor"][0] * length
                coordinate = feature["uv"][0] if feature else point["anchor"][0]
                right = local_x >= cut
                fraction = (coordinate * length - (cut if right else 0)) / (
                    length - cut if right else cut
                )
                if right:
                    point["element_id"] = second["id"]
                if feature:
                    # Resolve the new face basis without accepting or publishing an unvalidated document.
                    basis = features(draft, point["element_id"])[feature["id"]]
                    u = np.array(basis["u"])
                    fraction = float(
                        np.dot(old_world - basis["origin"], u) / np.dot(u, u)
                    )
                key = "uv" if feature else "anchor"
                owner = feature if feature else point
                owner[key] = [fraction, *owner[key][1:]]
        raw["elements"].append(second)
    proposed = Architecture.model_validate(raw)
    from .checks import inspect_geometry

    return {
        "document": proposed.model_dump(),
        "saved": False,
        "revision": request.expected_revision,
        "structure": structure_report(proposed),
        "geometry_checks": inspect_geometry(proposed),
        "limits": "Explicit numerical proposal. Agent must compare source photos and excluded landmarks before publishing. No inferred alignment or automatic gap closure.",
    }

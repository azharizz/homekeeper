"""Feature identity and measurements shared by photos, MCP and the viewer."""

import math
import numpy as np

from . import (
    AssetInstance,
    Box,
    Slab,
    Stair,
    Staircase,
    Wall,
    anchor_matrix,
    component_matrix,
    host_matrix,
)


def features(document, element_id):
    elements = {e.id: e for e in document.elements}
    levels = {e.id: e for e in document.levels}
    element = elements.get(element_id)
    result = {}

    def add(identifier, origin, u=(0, 0, 0), v=(0, 0, 0), matrix=None, normal=None):
        transform = np.eye(4) if matrix is None else matrix
        result[identifier] = {
            "id": identifier,
            "origin": (transform @ [*origin, 1])[:3].tolist(),
            "u": (transform @ [*u, 0])[:3].tolist(),
            "v": (transform @ [*v, 0])[:3].tolist(),
            "normal": (transform @ [*normal, 0])[:3].tolist() if normal else None,
        }

    if isinstance(element, Wall):
        matrix = host_matrix(element, levels)
        length, height = math.dist(element.start, element.end), element.height
        from .structure import wall_footprint

        footprint = np.array(wall_footprint(element, elements).exterior.coords)[:4]
        local = (
            np.c_[footprint[:, 0], np.zeros(4), footprint[:, 1], np.ones(4)]
            @ np.linalg.inv(matrix).T
        )
        for face, z, normal in (
            ("positive", element.thickness / 2, [0, 0, 1]),
            ("negative", -element.thickness / 2, [0, 0, -1]),
            ("centerline", 0, None),
        ):
            a, b = (
                (local[3, 0], local[2, 0])
                if face == "positive"
                else (local[0, 0], local[1, 0])
                if face == "negative"
                else (0, length)
            )
            add(
                f"wall:{face}", [a, 0, z], [b - a, 0, 0], [0, height, 0], matrix, normal
            )
            for endpoint, x in (("start", a), ("end", b)):
                add(f"wall:{endpoint}:{face}", [x, 0, z], [0, height, 0], matrix=matrix)
        for opening in element.openings:
            if not opening.id:
                continue
            for face, z in (
                ("positive", element.thickness / 2),
                ("negative", -element.thickness / 2),
                ("centerline", 0),
            ):
                for edge, origin, axis in (
                    ("left", [opening.offset, opening.sill, z], [0, opening.height, 0]),
                    (
                        "right",
                        [opening.offset + opening.width, opening.sill, z],
                        [0, opening.height, 0],
                    ),
                    ("sill", [opening.offset, opening.sill, z], [opening.width, 0, 0]),
                    (
                        "head",
                        [opening.offset, opening.sill + opening.height, z],
                        [opening.width, 0, 0],
                    ),
                ):
                    add(
                        f"opening:{opening.id}:{edge}:{face}",
                        origin,
                        axis,
                        matrix=matrix,
                    )
    elif isinstance(element, Slab):
        matrix = host_matrix(element, levels)
        for i, identifier in enumerate(element.vertex_ids):
            point, end = (
                element.polygon[i],
                element.polygon[(i + 1) % len(element.polygon)],
            )
            next_id = element.vertex_ids[(i + 1) % len(element.vertex_ids)]
            for face, y in (("top", 0), ("bottom", -element.thickness)):
                add(
                    f"vertex:{identifier}:{face}",
                    [point[0], y, point[1]],
                    matrix=matrix,
                )
                add(
                    f"edge:{identifier}:{next_id}:{face}",
                    [point[0], y, point[1]],
                    [end[0] - point[0], 0, end[1] - point[1]],
                    matrix=matrix,
                )
    elif isinstance(element, Box) and element.radius == 0:
        matrix = anchor_matrix(element, levels, elements)
        for axis in range(3):
            others = [i for i in range(3) if i != axis]
            for side in (0, 1):
                origin, u, v = np.zeros((3, 3))
                origin[axis], u[others[0]], v[others[1]] = side, 1, 1
                add(f"box:{'xyz'[axis]}:{side}", origin, u, v, matrix)
    elif isinstance(element, (Stair, Staircase)):
        flights = element.flights if isinstance(element, Staircase) else [element]
        y = levels[element.level].elevation
        for flight in flights:
            rise = (
                flight.rise
                if isinstance(element, Staircase)
                else levels[element.to_level].elevation - y
            )
            delta = np.array(flight.end) - flight.start
            across = (
                np.array([-delta[1], delta[0]]) / np.linalg.norm(delta) * flight.width
            )
            for endpoint, p, height in (
                ("start", flight.start, y),
                ("end", flight.end, y + rise),
            ):
                add(
                    f"flight:{flight.id}:{endpoint}",
                    [p[0] - across[0] / 2, height, p[1] - across[1] / 2],
                    [across[0], 0, across[1]],
                )
            y += rise
        if isinstance(element, Staircase):
            y = levels[element.level].elevation
            from .structure import cross_edge

            for i, landing in enumerate(element.landings):
                y += element.flights[i].rise
                for edge, flight, endpoint in (
                    ("arrival", element.flights[i], "end"),
                    ("departure", element.flights[i + 1], "start"),
                ):
                    a, b = np.array(cross_edge(flight, endpoint).coords)
                    add(
                        f"landing:{landing.id}:{edge}",
                        [a[0], y, a[1]],
                        [b[0] - a[0], 0, b[1] - a[1]],
                    )
    return result


def resolve_anchor(document, point):
    elements = {e.id: e for e in document.elements}
    levels = {e.id: e for e in document.levels}
    element = elements.get(point.element_id)
    if element is None:
        raise ValueError(f"Broken reference: element {point.element_id} was removed.")
    if point.feature is None:
        return (anchor_matrix(element, levels, elements) @ [*point.anchor, 1])[:3]
    identifier = point.feature.id
    if isinstance(element, AssetInstance) and identifier.startswith("asset:"):
        from .. import assets

        tokens = identifier.split(":")
        if (
            len(tokens) != 4
            or tokens[1] != element.asset_id
            or not all(t.isdecimal() for t in tokens[2:])
        ):
            raise ValueError(
                f"Broken reference: asset topology changed for {element.id}."
            )
        parts = assets.asset_parts(element.asset_id)
        part, vertex = map(int, tokens[2:])
        if part >= len(parts) or vertex >= len(parts[part].vertices):
            raise ValueError(f"Broken reference: missing asset vertex {identifier}.")
        return (
            component_matrix(element, levels, elements)
            @ [*(parts[part].vertices[vertex] * element.scale), 1]
        )[:3]
    feature = features(document, element.id).get(identifier)
    if feature is None:
        raise ValueError(
            f"Broken reference: {element.id}/{identifier} no longer exists."
        )
    return (
        np.array(feature["origin"])
        + point.feature.uv[0] * np.array(feature["u"])
        + point.feature.uv[1] * np.array(feature["v"])
    )


def dimension_report(document, dimension):
    points = [resolve_anchor(document, p) for p in (dimension.start, dimension.end)]
    if dimension.convention != "point_distance":
        refs = [p.feature for p in (dimension.start, dimension.end)]
        allowed = (
            {"wall:positive", "wall:negative"}
            if dimension.convention == "wall_faces"
            else {"wall:centerline"}
        )
        if any(ref is None or ref.id not in allowed for ref in refs):
            raise ValueError(
                "Wall dimensions require two explicit faces or two centerlines."
            )
        first, second = [
            features(document, p.element_id)[p.feature.id]
            for p in (dimension.start, dimension.end)
        ]
        direction = np.array(first["u"]) / np.linalg.norm(first["u"])
        other = np.array(second["u"]) / np.linalg.norm(second["u"])
        if abs(np.dot(direction, other)) < 1 - 1e-8:
            raise ValueError(
                "Clear wall dimensions need parallel surfaces; use point distance for angled walls."
            )
        origin, target = np.array(first["origin"]), np.array(second["origin"])
        a = np.dot(target - origin, direction)
        b = np.dot(target + second["u"] - origin, direction)
        low, high = max(0, min(a, b)), min(np.linalg.norm(first["u"]), max(a, b))
        y0, y1 = (
            max(origin[1], target[1]),
            min(origin[1] + first["v"][1], target[1] + second["v"][1]),
        )
        if high <= low or y1 <= y0:
            raise ValueError(
                "Selected wall surfaces do not share an along-wall span and height."
            )
        normal = np.array([-direction[2], 0, direction[0]])
        separation = np.dot(target - origin, normal)
        if first["normal"] is not None:
            if (
                np.dot(first["normal"], second["normal"]) > -1 + 1e-8
                or np.dot(target - origin, first["normal"]) <= 0
            ):
                raise ValueError("Choose inward-facing opposing wall faces.")
        p = origin + direction * (low + high) / 2
        p[1] = (y0 + y1) / 2
        points = [p, p + normal * separation]
    return dimension.model_dump() | {
        "distance_m": math.dist(*points),
        "world_points": [p.tolist() for p in points],
        "status": "estimated",
        "physical_evidence": False,
    }


def feature_catalog(document):
    from .. import assets

    result = {}
    for e in document.elements:
        value = {"label": e.label, "features": list(features(document, e.id).values())}
        if isinstance(e, AssetInstance):
            value["asset_vertices"] = {
                "id_pattern": f"asset:{e.asset_id}:PART_INDEX:VERTEX_INDEX",
                "parts": [len(m.vertices) for m in assets.asset_parts(e.asset_id)],
                "evidence": "Inspect the immutable asset geometry before choosing vertex indices.",
            }
        if value["features"] or isinstance(e, AssetInstance):
            result[e.id] = value
    return result

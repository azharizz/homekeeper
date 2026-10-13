"""Conservative model-only routes on one horizontal, authored floor surface."""

import heapq
import math
from itertools import pairwise

import numpy as np
import shapely
import trimesh
from pydantic import Field
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import nearest_points, polylabel, unary_union

from . import (
    Identifier,
    Number,
    Record,
    Slab,
    Zone,
    component_meshes,
    object_parts,
    slab_shape,
)
from .clearance import mesh_shells, section


class WalkingProfile(Record):
    expected_revision: int = Field(ge=1)
    floor_id: Identifier
    radius_m: float = Field(default=0.3, ge=0.1, le=1, allow_inf_nan=False)
    body_height_m: float = Field(default=1.8, ge=0.5, le=2.5, allow_inf_nan=False)
    eye_height_m: float = Field(default=1.65, ge=0.3, le=2.4, allow_inf_nan=False)


class WalkthroughRequest(WalkingProfile):
    target_id: Identifier
    start: tuple[Number, Number] | None = None
    stop_distance_m: float = Field(default=0.4, ge=0.1, le=3, allow_inf_nan=False)


def projected_obstacle(mesh, low, high):
    """Project the whole height band, rather than missing obstacles between slices."""
    if mesh.bounds[1, 1] <= low or mesh.bounds[0, 1] >= high:
        return Polygon()
    clipped = trimesh.intersections.slice_mesh_plane(mesh, [0, 1, 0], [0, low, 0])
    clipped = trimesh.intersections.slice_mesh_plane(clipped, [0, -1, 0], [0, high, 0])
    if not len(clipped.faces):
        return Polygon()
    triangles = clipped.triangles[:, :, [0, 2]]
    polygons = shapely.polygons(triangles)
    # Vertical triangles project to lines; retain them, including zero-thickness meshes.
    areas = shapely.area(polygons)
    lines = shapely.linestrings(triangles[areas <= 1e-12])
    middle = (max(low, mesh.bounds[0, 1]) + min(high, mesh.bounds[1, 1])) / 2
    filled = [
        section(part, middle)
        for part in mesh_shells(mesh)
        if part.bounds[0, 1] < middle < part.bounds[1, 1]
    ]
    return unary_union([*polygons[areas > 1e-12], *lines, *filled])


def floor_support(document, floor, height):
    elements = {e.id: e for e in document.elements}
    levels = {level.id: level.elevation for level in document.levels}
    support_ids = {
        e.id
        for e in document.elements
        if isinstance(e, Slab)
        and e.level == floor.level
        and abs(levels[e.level] + e.top - height) < 1e-6
    }
    support = unary_union([slab_shape(elements[i], elements) for i in support_ids])
    # Zones are annotations with no traversability contract. Never infer permission from labels.
    zones = [
        Polygon(e.polygon)
        for e in document.elements
        if isinstance(e, Zone) and e.level == floor.level
    ]
    support = support.difference(unary_union(zones))
    return support_ids, support


def walking_region(document, body):
    floor = next((e for e in document.elements if e.id == body.floor_id), None)
    if not isinstance(floor, Slab):
        raise ValueError("Choose an authored floor slab for the preview.")
    if body.eye_height_m >= body.body_height_m:
        raise ValueError("Eye height must be lower than body height.")
    height = (
        next(level.elevation for level in document.levels if level.id == floor.level)
        + floor.top
    )
    support_ids, support = floor_support(document, floor, height)
    meshes = component_meshes(document)
    # Three centimetres accommodate modeled floor finishes only, not climbable stairs.
    obstacles = unary_union(
        [
            projected_obstacle(mesh, height + 0.03, height + body.body_height_m)
            for key, mesh in meshes.items()
            if key not in support_ids
        ]
    )
    # A circumscribed buffer keeps the polygon approximation outside the requested radius.
    margin = body.radius_m / math.cos(math.pi / 32) + 0.002
    free = support.buffer(-margin, join_style="mitre").difference(
        obstacles.buffer(margin, quad_segs=8, join_style="mitre")
    )
    if free.is_empty:
        raise ValueError(
            "No walking area fits this body profile on the selected floor."
        )
    return floor, height, free, meshes


def visible_approach(eye, aim, triangles):
    """Finite ray/triangle test; other solids must not hide the chosen destination."""
    if not len(triangles):
        return True
    direction = np.asarray(aim) - eye
    edge1 = triangles[:, 1] - triangles[:, 0]
    edge2 = triangles[:, 2] - triangles[:, 0]
    h = np.cross(np.broadcast_to(direction, edge2.shape), edge2)
    determinant = np.einsum("ij,ij->i", edge1, h)
    valid = np.abs(determinant) > 1e-10
    inverse = np.divide(1.0, determinant, out=np.zeros_like(determinant), where=valid)
    s = eye - triangles[:, 0]
    u = inverse * np.einsum("ij,ij->i", s, h)
    q = np.cross(s, edge1)
    v = inverse * (q @ direction)
    t = inverse * np.einsum("ij,ij->i", edge2, q)
    return not bool(
        np.any(valid & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-5) & (t < 1 - 1e-5))
    )


def walking_area(document, body):
    floor, height, free, _ = walking_region(document, body)
    return {
        "revision": body.expected_revision,
        "floor_id": floor.id,
        "height": height,
        "polygons": [
            {
                "outer": list(p.exterior.coords),
                "holes": [list(r.coords) for r in p.interiors],
            }
            for p in shapely.get_parts(free)
            if isinstance(p, Polygon)
        ],
    }


def surface_aim(eye, target_triangles, blockers):
    # Aim at actual target surfaces, not an assembly box center that may be empty.
    samples = target_triangles.mean(axis=1)
    order = np.argsort(np.linalg.norm(samples - eye, axis=1))
    for index in order:
        if visible_approach(eye, samples[index], blockers):
            return samples[index]
    return None


def surface_route(
    region,
    support,
    start,
    target_shape,
    target_triangles,
    blockers,
    eye_y,
    stop_distance,
    point_goal=None,
):
    """Connected constrained triangles retain passages smaller than a raster cell."""
    triangles = list(shapely.constrained_delaunay_triangles(region).geoms)
    # ponytail: room-scale navigation; partition floors if authored geometry exceeds this budget.
    if len(triangles) > 20_000:
        raise ValueError(
            "This floor is too detailed for the route preview. Simplify its collision geometry."
        )
    centers = [np.array(p.centroid.coords[0]) for p in triangles]
    edges, neighbors = {}, [[] for _ in triangles]
    for i, triangle in enumerate(triangles):
        for a, b in pairwise(triangle.exterior.coords):
            edge = tuple(sorted((a, b)))
            if edge in edges:
                j = edges.pop(edge)
                portal = (np.array(a) + np.array(b)) / 2
                neighbors[i].append((j, portal))
                neighbors[j].append((i, portal))
            else:
                edges[edge] = i
    costs, previous, queue = {}, {}, []
    for i, triangle in enumerate(triangles):
        if triangle.covers(Point(start)):
            costs[i] = math.dist(start, centers[i])
            heapq.heappush(queue, (costs[i], i))
    if not queue:
        raise ValueError(
            "The selected start cannot join the floor surface. Pick inside the highlighted area."
        )
    while queue:
        cost, current = heapq.heappop(queue)
        if cost != costs[current]:
            continue
        for other, portal in neighbors[current]:
            candidate = (
                cost
                + math.dist(centers[current], portal)
                + math.dist(portal, centers[other])
            )
            if candidate < costs.get(other, math.inf):
                costs[other] = candidate
                previous[other] = (current, portal)
                heapq.heappush(queue, (candidate, other))
    if point_goal is not None:
        point = np.asarray(point_goal, dtype=float)
        goals = [i for i in costs if triangles[i].covers(Point(point))]
        if not goals:
            raise ValueError("The recorded point has no connected body-clear floor approach.")
        goal = min(goals, key=lambda i: costs[i] + math.dist(centers[i], point))
        cost = 0 if math.dist(start, point) < 1e-8 else costs[goal] + math.dist(centers[goal], point)
        aim = np.array([point[0], eye_y, point[1]])
    else:
        # Search near the object's approach, not a far-away viewpoint through a blocked doorway.
        excluded = target_shape.buffer(stop_distance / math.cos(math.pi / 64), quad_segs=16)
        candidates = []
        for i in costs:
            area = triangles[i].difference(excluded)
            if area.is_empty:
                continue
            point = np.array(nearest_points(area, target_shape)[0].coords[0])
            gap = target_shape.distance(Point(point))
            if gap > stop_distance + 0.05:
                continue
            cost = costs[i] + math.dist(centers[i], point)
            candidates.append((gap, cost, i, point))
        start_gap = target_shape.distance(Point(start))
        if stop_distance <= start_gap <= stop_distance + 0.05 and costs:
            candidates.append((start_gap, 0, min(costs, key=costs.get), np.array(start)))
        # Prefer short approaches within 5 cm of the requested clearance, then the nearest visible surface.
        candidates.sort(key=lambda c: (max(0, c[0] - stop_distance - 0.05), c[1]))
        for gap, cost, goal, point in candidates:
            nearest = nearest_points(Point(point), target_shape)[1]
            # Visibility across a missing floor or annotated void does not establish arrival.
            if not support.buffer(1e-9).covers(LineString([point, nearest.coords[0]])):
                continue
            aim = surface_aim(
                np.array([point[0], eye_y, point[1]]), target_triangles, blockers
            )
            if aim is not None:
                break
        else:
            raise ValueError(
                "No connected approach can see a surface of this object. Check modeled barriers or choose another destination."
            )
    path = [point.tolist()]
    if cost:
        path.append(centers[goal].tolist())
        while goal in previous:
            goal, portal = previous[goal]
            path.extend([portal.tolist(), centers[goal].tolist()])
    path.append(list(start))
    path.reverse()
    # GEOS can produce sub-nanometre round-off on shared edges. No geometric clearance is relaxed.
    check = region.buffer(1e-9)
    smooth, cursor = [path[0]], 0
    while cursor < len(path) - 1:
        next_index = len(path) - 1
        while next_index > cursor + 1 and not check.covers(
            LineString([path[cursor], path[next_index]])
        ):
            next_index -= 1
        if not check.covers(LineString([path[cursor], path[next_index]])):
            raise ValueError(
                "The modeled floor connection is numerically degenerate. Review the floor geometry."
            )
        if math.dist(smooth[-1], path[next_index]) > 1e-8:
            smooth.append(path[next_index])
        cursor = next_index
    if len(smooth) == 1:
        smooth.append(smooth[0])
    return smooth, aim


def plan_walkthrough(document, body):
    floor, height, free, meshes = walking_region(document, body)
    group = object_parts(document, body.target_id)
    selected = next(e for e in group if e.id == body.target_id)
    if selected.level != floor.level or selected.kind not in {
        "box",
        "solid",
        "asset",
        "rail",
    }:
        raise ValueError(
            "Choose a solid object on the selected floor as the destination."
        )
    target_meshes = [meshes[e.id] for e in group if e.id in meshes]
    target_shape = unary_union(
        [
            projected_obstacle(mesh, mesh.bounds[0, 1] - 1e-6, mesh.bounds[1, 1] + 1e-6)
            for mesh in target_meshes
        ]
    )
    polygons = [
        p for p in shapely.get_parts(free) if isinstance(p, Polygon) and p.area > 1e-6
    ]
    if body.start is None:
        region = max(polygons, key=lambda p: p.area)
        start = polylabel(region, tolerance=0.05).coords[0]
    else:
        start = body.start
        region = next((p for p in polygons if p.covers(Point(start))), None)
        if region is None:
            gap = free.distance(Point(start))
            raise ValueError(
                f"This start is {gap:.2f} m outside the body-clear area for a {2 * body.radius_m:.2f} m body width. Pick inside the highlighted floor area; the point has not been moved."
            )
    group_ids = {e.id for e in group}
    other_triangles = [
        mesh.triangles for key, mesh in meshes.items() if key not in group_ids
    ]
    blockers = (
        np.concatenate(other_triangles) if other_triangles else np.empty((0, 3, 3))
    )
    path, aim = surface_route(
        region,
        floor_support(document, floor, height)[1],
        start,
        target_shape,
        np.concatenate([mesh.triangles for mesh in target_meshes]),
        blockers,
        height + body.eye_height_m,
        max(body.stop_distance_m, free.distance(target_shape)),
    )
    distance = sum(math.dist(a, b) for a, b in pairwise(path))
    return {
        "revision": body.expected_revision,
        "floor_id": floor.id,
        "target_id": body.target_id,
        "target_label": selected.assembly or selected.label,
        "target_position": aim.tolist(),
        "points": [[x, height, z] for x, z in path],
        "distance_m": distance,
        "approach_gap_m": target_shape.distance(Point(path[-1])),
        "requested_stop_distance_m": body.stop_distance_m,
        "start_is_automatic": body.start is None,
        "profile": {
            "radius_m": body.radius_m,
            "body_height_m": body.body_height_m,
            "eye_height_m": body.eye_height_m,
            "stop_distance_m": body.stop_distance_m,
        },
        "routing_method": "constrained_floor_triangles",
        "floor_finish_tolerance_m": 0.03,
        "units": "estimated_metres",
        "physical_position": "unknown",
        "limitations": [
            "Virtual model preview, not a verified safe route or live physical position.",
            "Distance depends on authored dimensions; step length is a user-adjustable estimate.",
            "Single horizontal surface only. Stairs, unsupported space and all annotation zones are excluded.",
            "Body envelope uses all modeled geometry, including door leaves and glass. Missing obstacles are unknown.",
            "Floor finishes up to 3 cm are ignored. Extremely narrow modeled connections still depend on accurate geometry.",
        ],
    }

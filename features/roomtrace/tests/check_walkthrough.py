"""Model-route geometry tests. These synthetic rooms do not establish physical safety."""

import copy
import math
import sys
from pathlib import Path

from shapely.geometry import LineString, Point
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.architecture import Architecture
from app.architecture.walkthrough import (
    WalkthroughRequest,
    plan_walkthrough,
    projected_obstacle,
    walking_region,
)


def item(id, kind, **fields):
    return dict(
        id=id,
        kind=kind,
        label=id,
        level="ground",
        sources=["a.jpg"],
        evidence="Synthetic geometry check.",
        color="#998877",
        **fields,
    )


raw = dict(
    title="Walkthrough checks",
    notes=["Synthetic fixture"],
    levels=[dict(id="ground", name="Ground", elevation=0)],
    elements=[
        item("floor", "slab", polygon=[[0, 0], [6, 0], [6, 6], [0, 6]], thickness=0.2),
        item("target", "box", position=[5.5, 1.5, 3], size=[0.1, 0.6, 0.8]),
        item("table", "box", position=[3, 0.5, 3], size=[1, 1, 2]),
    ],
)
body = WalkthroughRequest(
    expected_revision=1,
    floor_id="floor",
    target_id="target",
    start=[0.8, 3],
    stop_distance_m=1.2,
)


def route_check(source, request=body):
    doc = Architecture.model_validate(source)
    result = plan_walkthrough(doc, request)
    _, _, free, _ = walking_region(doc, request)
    route = LineString([[p[0], p[2]] for p in result["points"]])
    assert free.buffer(1e-9).covers(route), (
        "Every segment must stay in the body-clear region"
    )
    assert math.isclose(route.length, result["distance_m"], abs_tol=1e-9)
    assert result["physical_position"] == "unknown"
    return result


def rejects(source, phrase, request=body):
    try:
        plan_walkthrough(Architecture.model_validate(source), request)
    except ValueError as error:
        assert phrase in str(error), str(error)
    else:
        raise AssertionError("Expected rejection: " + phrase)


tall_a = trimesh.creation.box([2, 4, 2])
tall_b = tall_a.copy()
tall_b.apply_translation([1, 0, 0])
projected = projected_obstacle(trimesh.util.concatenate([tall_a, tall_b]), 0.03, 1.8)
assert projected.covers(Point(0.5, 0)), (
    "Overlapping solid shells must not cancel by parity"
)

result = route_check(raw)
assert len(result["points"]) > 2, "Table must cause a detour"
assert result["distance_m"] > math.dist(result["points"][0], result["points"][-1]) + 0.1
assert 1.2 - 1e-9 <= result["approach_gap_m"] <= 1.342
route_check(raw, body.model_copy(update={"start": None}))
rejects(raw, "outside the body-clear area", body.model_copy(update={"start": [3, 3]}))
rejects(raw, "outside the body-clear area", body.model_copy(update={"start": [-1, 3]}))

hole = copy.deepcopy(raw)
hole["elements"] = [e for e in hole["elements"] if e["id"] != "table"]
hole["elements"][0]["holes"] = [[[2.5, 2], [3.5, 2], [3.5, 4], [2.5, 4]]]
assert len(route_check(hole)["points"]) > 2
zone = copy.deepcopy(raw)
zone["elements"] = [e for e in zone["elements"] if e["id"] != "table"]
zone["elements"].append(
    item("unassessed", "zone", polygon=[[2.5, 2], [3.5, 2], [3.5, 4], [2.5, 4]])
)
assert len(route_check(zone)["points"]) > 2

doorway = copy.deepcopy(raw)
doorway["elements"] = [e for e in doorway["elements"] if e["id"] != "table"]
doorway["elements"].append(
    item(
        "partition",
        "wall",
        start=[3, 0],
        end=[3, 6],
        height=3,
        thickness=0.2,
        openings=[
            dict(id="door", kind="door", offset=2.4, width=1.2, height=2.1, sill=0)
        ],
    )
)
route_check(doorway)
closed = copy.deepcopy(doorway)
closed["elements"].append(
    item("leaf", "box", position=[3, 1.04, 3], size=[0.04, 2.08, 1.2])
)
rejects(closed, "No connected approach")
low = copy.deepcopy(doorway)
low["elements"][-1]["openings"][0]["height"] = 1.4
rejects(low, "No connected approach")
narrow = copy.deepcopy(doorway)
narrow["elements"][-1]["openings"][0].update(offset=2.75, width=0.5)
rejects(narrow, "No connected approach")

ceiling = copy.deepcopy(raw)
ceiling["elements"].append(
    item(
        "ceiling",
        "slab",
        polygon=[[0, 0], [6, 0], [6, 6], [0, 6]],
        top=1.7,
        thickness=0.1,
    )
)
rejects(ceiling, "No walking area")
overhead = copy.deepcopy(raw)
overhead["elements"][2]["position"][1] = 2.5
assert len(route_check(overhead)["points"]) == 2, (
    "Geometry above the head must not obstruct floor routing"
)
disconnected = copy.deepcopy(doorway)
disconnected["elements"][0]["holes"] = [
    [[2.5, 0.01], [3.5, 0.01], [3.5, 5.99], [2.5, 5.99]]
]
# The target is visible through a doorway but cannot be reached on the modeled floor.
# An approach on this side must not be reported as arrival across an unsupported gap.
doc = Architecture.model_validate(disconnected)
_, _, free, _ = walking_region(doc, body)
assert not free.covers(LineString([[0.8, 3], [5, 3]]))
rejects(disconnected, "No connected approach")
# This 1.3 cm body-clear passage falls between 10 cm grid rows. It remains connected.
thin = copy.deepcopy(raw)
thin["elements"] = [e for e in thin["elements"] if e["id"] != "table"]
thin["elements"].extend(
    [
        item("upper", "box", position=[3, 1, 1.78], size=[2, 2, 2.44]),
        item("lower", "box", position=[3, 1, 4.54], size=[2, 2, 1.84]),
    ]
)
route_check(thin)
# A near start uses the requested minimum gap without relocating the start.
near = body.model_copy(update={"start": [4.2, 3], "stop_distance_m": 0.4})
route_check(raw, near)

# An assembly center can sit inside another object. Aim at its actual surfaces.
separated = copy.deepcopy(raw)
separated["elements"] = [e for e in separated["elements"] if e["id"] != "table"]
separated["elements"][1].update(
    position=[5, 1, 1], size=[0.3, 1, 0.3], assembly="paired"
)
separated["elements"].extend(
    [
        item(
            "other_part",
            "box",
            position=[5, 1, 5],
            size=[0.3, 1, 0.3],
            assembly="paired",
        ),
        item("center_blocker", "box", position=[5, 1, 3], size=[1, 2, 2]),
    ]
)
separated_result = route_check(separated)
assert abs(separated_result["target_position"][2] - 3) > 1, (
    "Object marker must point at geometry, not the empty assembly center"
)

print(
    "PASS: route distance, detours, body envelope, floor holes, zones, low heads, narrow doors and closed door leaves"
)


def check_api():
    import tempfile

    from fastapi.testclient import TestClient

    from app import config, store
    from app.main import app

    saved_data = config.DATA
    saved_store_data = store.DATA
    with tempfile.TemporaryDirectory() as directory:
        config.DATA = Path(directory)
        store.DATA = config.DATA
        try:
            job = store.create_job("Walk test", {"engine": "architecture"})
            artifact_revision = "a" * 32
            target = store.artifact_dir(job | {"artifact_revision": artifact_revision})
            target.mkdir(parents=True)
            store.atomic_json(
                target / "architecture.json",
                Architecture.model_validate(raw).model_dump(),
            )
            store.update_job(
                job["id"],
                status="ready",
                revision=1,
                artifact_revision=artifact_revision,
            )
            headers = (
                {"authorization": "Bearer " + config.ACCESS_TOKEN}
                if config.ACCESS_TOKEN
                else {}
            )
            with TestClient(
                app, headers=headers, base_url="http://127.0.0.1"
            ) as client:
                url = f"/api/maps/{job['id']}/architecture/walkthrough"
                response = client.post(url, json=body.model_dump())
                assert response.status_code == 200, response.text
                assert response.json()["revision"] == 1
                area_url = url + "-area"
                area_body = {"expected_revision": 1, "floor_id": "floor"}
                area_response = client.post(area_url, json=area_body)
                assert area_response.status_code == 200, area_response.text
                assert area_response.json()["polygons"]
                assert (
                    client.post(
                        area_url, json=area_body | {"expected_revision": 2}
                    ).status_code
                    == 409
                )
                assert (
                    client.post(
                        area_url, json=area_body | {"floor_id": "target"}
                    ).status_code
                    == 422
                )
                assert (
                    client.post(
                        url, json=body.model_dump() | {"expected_revision": 2}
                    ).status_code
                    == 409
                )
                assert (
                    client.post(
                        url, json=body.model_dump() | {"radius_m": 0}
                    ).status_code
                    == 422
                )
                assert (
                    client.post(
                        url, json=body.model_dump() | {"target_id": "missing"}
                    ).status_code
                    == 422
                )
                assert store.get_job(job["id"])["revision"] == 1
        finally:
            config.DATA = saved_data
            store.DATA = saved_store_data
    print(
        "PASS: real HTTP route, invalid profile/target, revision conflict, no publication"
    )


check_api()


if "--living-room" in sys.argv:
    import hashlib
    import json
    from app import store

    job = store.get_job("ecc1c20c1b0340468c284e2b4fb86e4b")
    directory = store.job_dir(job["id"])
    before = {
        str(p): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in directory.rglob("*")
        if p.is_file()
    }
    capture = Architecture.model_validate_json(
        (store.artifact_dir(job) / "architecture.json").read_text()
    )
    results = []
    for target in ("corner_tree", "tv_frame", "sofa"):
        request = WalkthroughRequest(
            expected_revision=job["revision"],
            floor_id="floor",
            target_id=target,
            start=[6.2, 3],
        )
        result = plan_walkthrough(capture, request)
        _, _, free, _ = walking_region(capture, request)
        assert free.buffer(1e-9).covers(
            LineString([[p[0], p[2]] for p in result["points"]])
        )
        assert result["points"][0] == [6.2, 0, 3], "Never relocate a picked start"
        results.append(result)
    after = {
        str(p): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in directory.rglob("*")
        if p.is_file()
    }
    assert before == after
    Path("reports/walkthrough/corrected-routes.json").write_text(
        json.dumps(results, indent=2)
    )
    print(
        "PASS: real behind-sofa routes to tree, TV and sofa; saved capture files unchanged"
    )

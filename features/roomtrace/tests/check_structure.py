"""Geometric contracts only. Synthetic fixtures do not certify a home or walking route."""

import copy
import sys
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.architecture import (
    Architecture,
    ModelAnchor,
    ModelDimension,
    build_mesh,
    component_meshes,
    mesh_element,
    slab_shape,
)
from app.architecture.features import resolve_anchor, dimension_report
from app.architecture.structure import (
    StructureEdit,
    propose_structure,
    structure_report,
    wall_footprint,
)
from app.architecture.clearance import section
from app.architecture.checks import inspect_geometry
from app.architecture.refinement import scale_document


def item(id, kind, **fields):
    return dict(
        id=id,
        kind=kind,
        label=id,
        level="ground",
        sources=["a.jpg"],
        evidence="Mathematical test fixture.",
        color="#998877",
        **fields,
    )


raw = dict(
    title="Structure assertions",
    notes=["Not acceptance data."],
    levels=[
        dict(id="ground", name="Ground", elevation=0),
        dict(id="upper", name="Upper", elevation=3),
    ],
    elements=[
        item(
            "south",
            "wall",
            start=[0, 0],
            end=[6, 0],
            height=3,
            thickness=0.2,
            start_joint="sw",
            end_joint="se",
            openings=[
                dict(
                    id="door",
                    kind="door",
                    offset=1,
                    width=1,
                    sill=0,
                    height=2,
                    swing="left_positive",
                    swing_degrees=90,
                ),
                dict(
                    id="window", kind="window", offset=4, width=1, sill=0.7, height=1.2
                ),
            ],
        ),
        item(
            "north",
            "wall",
            start=[6, 4],
            end=[0, 4],
            height=3,
            thickness=0.2,
            start_joint="ne",
            end_joint="nw",
        ),
        item(
            "west",
            "wall",
            start=[0, 4],
            end=[0, 0],
            height=3,
            thickness=0.2,
            start_joint="nw",
            end_joint="sw",
        ),
        item(
            "east",
            "wall",
            start=[6, 0],
            end=[6, 4],
            height=3,
            thickness=0.2,
            start_joint="se",
            end_joint="ne",
        ),
        item(
            "floor",
            "slab",
            polygon=[[0, 0], [6, 0], [6, 4], [0, 4]],
            vertex_ids=["a", "b", "c", "d"],
            thickness=0.2,
        ),
        item(
            "trim",
            "box",
            position=[0, 0, 0.2],
            size=[0.8, 0.8, 0.1],
            attachment=dict(host="south", opening="window"),
        ),
    ],
)


def anchor(element, feature, uv=(0.5, 0.5)):
    return ModelAnchor(element_id=element, feature=dict(id=feature, uv=uv))


def rejects(operation, message):
    try:
        operation()
    except ValueError as error:
        assert message.lower() in str(error).lower(), str(error)
    else:
        raise AssertionError("Expected rejection: " + message)


doc = Architecture.model_validate(raw)
p = anchor("south", "opening:door:left:positive", (0.25, 0))
assert np.allclose(resolve_anchor(doc, p), [1, 0.5, 0.1])
changed = copy.deepcopy(raw)
changed["elements"][0]["openings"][0]["offset"] = 2
assert np.allclose(
    resolve_anchor(Architecture.model_validate(changed), p), [2, 0.5, 0.1]
)
with_dimension = doc.model_dump()
with_dimension["dimensions"] = [
    dict(
        id="jamb",
        label="Door jamb",
        start=p.model_dump(),
        end=anchor("south", "opening:door:right:positive", (0.25, 0)).model_dump(),
    )
]
document = Architecture.model_validate(with_dimension)
assert dimension_report(document, document.dimensions[0])["distance_m"] == 1
broken = document.model_dump()
broken["elements"][0]["openings"] = broken["elements"][0]["openings"][1:]
rejects(lambda: Architecture.model_validate(broken), "broken reference")
for convention, feature, expected in (
    ("wall_faces", "positive", 3.8),
    ("wall_centerlines", "centerline", 4.0),
):
    d = ModelDimension(
        id="width",
        label="Room width",
        start=anchor("south", "wall:" + feature),
        end=anchor("north", "wall:" + feature),
        convention=convention,
    )
    assert abs(dimension_report(doc, d)["distance_m"] - expected) < 1e-8
rejects(
    lambda: dimension_report(
        doc,
        ModelDimension(
            id="bad",
            label="Bad",
            start=anchor("south", "wall:negative"),
            end=anchor("north", "wall:negative"),
            convention="wall_faces",
        ),
    ),
    "inward-facing",
)
v = anchor("floor", "vertex:b:top")
assert np.allclose(resolve_anchor(doc, v), [6, 0, 0])
reordered = doc.model_dump()
floor = reordered["elements"][4]
floor["polygon"] = [floor["polygon"][-1], *floor["polygon"][:-1]]
floor["vertex_ids"] = [floor["vertex_ids"][-1], *floor["vertex_ids"][:-1]]
assert np.allclose(resolve_anchor(Architecture.model_validate(reordered), v), [6, 0, 0])
print(
    "PASS: named jambs, vertex identity, broken references and clear versus centerline dimensions"
)

report = structure_report(doc)
assert len(report["topology"][0]["closed_boundaries"]) == 1
assert not report["topology"][0]["unconnected_endpoints"]
levels, elements = {e.id: e for e in doc.levels}, {e.id: e for e in doc.elements}
footprints = [wall_footprint(e, elements) for e in doc.elements if e.kind == "wall"]
from shapely.ops import unary_union

assert abs(unary_union(footprints).area - (6.2 * 4.2 - 5.8 * 3.8)) < 1e-7
assert all(
    a.intersection(b).area < 1e-8
    for i, a in enumerate(footprints)
    for b in footprints[i + 1 :]
)
opened = doc.model_dump()
opened["elements"] = [e for e in opened["elements"] if e["id"] != "east"]
assert not structure_report(Architecture.model_validate(opened))["topology"][0][
    "closed_boundaries"
]
move = propose_structure(
    doc,
    StructureEdit(
        expected_revision=1, operation="move_joint", joint_id="se", position=(6.2, 0)
    ),
)
assert (
    move["document"]["elements"][0]["end"] == move["document"]["elements"][3]["start"]
)
rejects(
    lambda: propose_structure(
        doc,
        StructureEdit(
            expected_revision=1,
            operation="split_wall",
            wall_id="south",
            offset=1.5,
            new_wall_id="second",
        ),
    ),
    "through an opening",
)
split = propose_structure(
    document,
    StructureEdit(
        expected_revision=1,
        operation="split_wall",
        wall_id="south",
        offset=3,
        new_wall_id="second",
    ),
)
split_doc = Architecture.model_validate(split["document"])
assert np.allclose(
    resolve_anchor(split_doc, split_doc.dimensions[0].start),
    resolve_anchor(document, document.dimensions[0].start),
)
new_elements = {e.id: e for e in split_doc.elements}
assert new_elements["trim"].attachment.host == "second"
assert np.allclose(
    mesh_element(elements["trim"], levels, elements).bounds,
    mesh_element(new_elements["trim"], levels, new_elements).bounds,
)
aligned = propose_structure(
    doc,
    StructureEdit(
        expected_revision=1,
        operation="align_openings",
        wall_id="south",
        opening_id="window",
        target_opening_id="door",
        alignment="head",
    ),
)
assert abs(aligned["document"]["elements"][0]["openings"][1]["sill"] - 0.8) < 1e-8
print(
    "PASS: mitered shared joints, observed boundaries, explicit alignment and attachment-preserving splits"
)

face_document = doc.model_dump()
face_document["dimensions"] = [
    dict(
        id=f"face_{i}",
        label="Stable face point",
        start=anchor("south", "wall:positive", (fraction, 0.25)).model_dump(),
        end=anchor("south", "wall:negative", (fraction, 0.25)).model_dump(),
    )
    for i, fraction in enumerate((0, 0.25, 0.5, 0.9, 1))
]
face_document = Architecture.model_validate(face_document)
split_faces = Architecture.model_validate(
    propose_structure(
        face_document,
        StructureEdit(
            expected_revision=1,
            operation="split_wall",
            wall_id="south",
            offset=3,
            new_wall_id="second",
        ),
    )["document"]
)
for before, after in zip(face_document.dimensions, split_faces.dimensions):
    for a, b in ((before.start, after.start), (before.end, after.end)):
        assert np.allclose(
            resolve_anchor(face_document, a), resolve_anchor(split_faces, b)
        )

stairs = copy.deepcopy(raw)
stairs["elements"] += [
    item(
        "chain",
        "staircase",
        to_level="upper",
        tread_thickness=0.03,
        flights=[
            dict(
                id="lower",
                start=[2, 0],
                end=[2, 2],
                rise=1.5,
                width=1,
                risers=8,
                opening=dict(slab="upper_floor"),
            ),
            dict(
                id="higher",
                start=[2.5, 2.5],
                end=[4.5, 2.5],
                rise=1.5,
                width=1,
                risers=8,
                opening=dict(slab="upper_floor"),
            ),
        ],
        landings=[
            dict(
                id="turn",
                polygon=[[1.5, 2], [2.5, 2], [2.5, 3], [1.5, 3]],
                thickness=0.15,
            )
        ],
    )
]
upper = item(
    "upper_floor", "slab", polygon=[[0, 0], [6, 0], [6, 4], [0, 4]], thickness=0.2
)
upper["level"] = "upper"
stairs["elements"].append(upper)
stairdoc = Architecture.model_validate(stairs)
components = component_meshes(stairdoc)
assert np.allclose(components["chain"].bounds[:, 1], [0, 3])
assert len(build_mesh(stairdoc).geometry) == len(stairdoc.elements)
assert np.allclose(
    resolve_anchor(stairdoc, anchor("chain", "flight:higher:end")), [4.5, 3, 2.5]
)
slabs = {e.id: e for e in stairdoc.elements}
assert abs(slab_shape(slabs["upper_floor"], slabs).area - 20) < 1e-6
scaled = scale_document(stairdoc, 2)
assert np.allclose(
    resolve_anchor(scaled, anchor("chain", "flight:higher:end")), [9, 6, 5]
)
badstairs = copy.deepcopy(stairs)
badstairs["elements"][-2]["flights"][1]["start"] = [3, 2.5]
rejects(lambda: Architecture.model_validate(badstairs), "full width")
badstairs = copy.deepcopy(stairs)
badstairs["elements"][-2]["flights"][1]["rise"] = 1.6
rejects(lambda: Architecture.model_validate(badstairs), "destination elevation")
print(
    "PASS: connected flights, landings, target elevations, cut geometry, stable stair features and physical scaling"
)

u_stair = copy.deepcopy(stairs)
chain = u_stair["elements"][-2]
chain["flights"][1].update(start=[3, 2], end=[3, 0])
chain["landings"][0]["polygon"] = [[1.5, 2], [3.5, 2], [3.5, 3], [1.5, 3]]
u_doc = Architecture.model_validate(u_stair)
assert np.allclose(component_meshes(u_doc)["chain"].bounds[:, 1], [0, 3])
assert np.allclose(
    resolve_anchor(u_doc, anchor("chain", "landing:turn:departure")), [3, 1.5, 2]
)

collisions = copy.deepcopy(raw)
collisions["elements"] += [
    item("a", "box", position=[1.5, 0.5, 0.5], size=[0.4, 1, 0.4], yaw=0.4),
    item("b", "box", position=[1.55, 0.5, 0.5], size=[0.4, 1, 0.4], yaw=-0.4),
    item("above", "box", position=[1.5, 3, 0.5], size=[0.4, 1, 0.4]),
]
collisiondoc = Architecture.model_validate(collisions)
issues = inspect_geometry(collisiondoc)["issues"]
assert any(
    i["code"] == "object_section_overlap" and set(i["elements"]) == {"a", "b"}
    for i in issues
)
assert not any(
    i["code"] == "object_section_overlap" and "above" in i["elements"] for i in issues
)
assert any(i["code"] == "door_swing_overlap" and "a" in i["elements"] for i in issues)
# Empty center of a hollow extrusion must stay empty in a section.
import trimesh

ring = trimesh.creation.extrude_polygon(
    Polygon([(0, 0), (3, 0), (3, 3), (0, 3)], [[(1, 1), (2, 1), (2, 2), (1, 2)]]),
    1,
    engine="earcut",
)
ring.apply_transform([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1]])
assert abs(section(ring, 0.5).area - 8) < 1e-7
print(
    "PASS: actual rotated mesh sections, vertical separation, authored door sweeps and hollow outlines"
)


async def api():
    import tempfile
    import httpx
    from PIL import Image
    from app import config, store, assets
    from app.main import app
    from app.architecture.alignment import world_points

    original = config.DATA, store.DATA
    with tempfile.TemporaryDirectory() as directory:
        config.DATA = store.DATA = Path(directory)
        try:
            job = store.create_job("Structure fixture", {"engine": "architecture"})
            store.update_job(job["id"], status="awaiting_agent")
            folder = store.job_dir(job["id"])
            (folder / "images").mkdir()
            Image.new("RGB", (64, 64)).save(folder / "images/a.jpg")
            store.atomic_json(
                folder / "frames.json", [dict(name="a.jpg", size=[64, 64])]
            )
            spec = assets.AssetSpec(
                name="Fixture",
                description="Arbitrary tetrahedron",
                provenance="Math fixture",
                metres_per_unit=1,
                dimension_note="Not physical evidence",
                sources=[dict(map_id=job["id"], source="a.jpg", note="Test image")],
            )
            tetra = assets.create_mesh(
                assets.MeshAsset(
                    spec=spec,
                    parts=[
                        dict(
                            name="tetra",
                            vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
                            faces=[[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
                            color="#aabbcc",
                        )
                    ],
                )
            )
            asset_raw = doc.model_dump()
            asset_raw["elements"].append(
                item(
                    "mesh",
                    "asset",
                    asset_id=tetra["id"],
                    position=[2, 0, 2],
                    scale=2,
                    yaw=0.3,
                )
            )
            asset_doc = Architecture.model_validate(asset_raw)
            ref = anchor("mesh", f"asset:{tetra['id']}:0:0")
            from app.architecture import instance_meshes

            element = asset_doc.elements[-1]
            expected = instance_meshes(
                element, levels, {e.id: e for e in asset_doc.elements}
            )[0].vertices[0]
            assert np.allclose(resolve_anchor(asset_doc, ref), expected)
            assert np.allclose(world_points(asset_doc, [ref])[0], expected)
            rejects(
                lambda: resolve_anchor(
                    asset_doc, anchor("mesh", "asset:" + "0" * 64 + ":0:0")
                ),
                "topology changed",
            )
            headers = (
                {"authorization": "Bearer " + config.ACCESS_TOKEN}
                if config.ACCESS_TOKEN
                else {}
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://localhost",
                timeout=None,
                headers=headers,
            ) as client:
                base = f"/api/maps/{job['id']}/architecture"
                published = await client.post(
                    base, json=dict(expected_revision=0, document=document.model_dump())
                )
                assert published.status_code == 200, published.text
                artifact = store.artifact_dir(store.get_job(job["id"]))
                mesh_bytes = (artifact / "surface.glb").read_bytes()
                result = await client.get(base + "/structure")
                assert (
                    result.status_code == 200
                    and result.json()["dimensions"][0]["distance_m"] == 1
                )
                proposal = await client.post(
                    base + "/structure-proposal",
                    json=dict(
                        expected_revision=1,
                        operation="split_wall",
                        wall_id="south",
                        offset=3,
                        new_wall_id="second",
                    ),
                )
                assert proposal.status_code == 200, proposal.text
                assert (
                    not proposal.json()["saved"]
                    and store.get_job(job["id"])["revision"] == 1
                )
                invalid = await client.post(
                    base + "/structure-proposal",
                    json=dict(expected_revision=0, operation="move_joint"),
                )
                assert invalid.status_code == 422
                stale = await client.post(
                    base + "/structure-proposal",
                    json=dict(
                        expected_revision=2,
                        operation="move_joint",
                        joint_id="sw",
                        position=[0, 0],
                    ),
                )
                assert stale.status_code == 409
                invalid = await client.post(
                    base, json=dict(expected_revision=1, document=broken)
                )
                assert invalid.status_code == 422 and "Broken reference" in invalid.text
                width = ModelDimension(
                    id="clear",
                    label="Inside width",
                    start=anchor("south", "wall:positive"),
                    end=anchor("north", "wall:positive"),
                    convention="wall_faces",
                )
                saved = await client.post(
                    base + "/dimensions",
                    json=dict(expected_revision=1, dimension=width.model_dump()),
                )
                assert saved.status_code == 200, saved.text
                result = (await client.get(base + "/structure")).json()
                assert (
                    result["revision"] == 2
                    and abs(result["dimensions"][-1]["distance_m"] - 3.8) < 1e-8
                )
                assert (artifact / "surface.glb").read_bytes() == mesh_bytes
                duplicate = await client.post(
                    base + "/dimensions",
                    json=dict(expected_revision=2, dimension=width.model_dump()),
                )
                assert duplicate.status_code == 422
        finally:
            config.DATA, store.DATA = original
    print(
        "PASS: asset topology references, shared photo resolver, HTTP publication, saved dimensions, preview isolation, immutable history, stale revisions and invalid references"
    )


import asyncio

asyncio.run(api())

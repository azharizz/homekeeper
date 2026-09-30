"""Verify the actual stdio server against the running local API, without a mock transport."""

import asyncio
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import store  # noqa: E402
from app.architecture import Architecture  # noqa: E402


async def main():
    async with stdio_client(
        StdioServerParameters(
            command=sys.executable,
            args=[str(ROOT / "app/mcp_server.py")],
            env={**os.environ},
        )
    ) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            tools = await client.list_tools()
            assert {tool.name for tool in tools.tools} == {
                "list_maps",
                "inspect_map",
                "reference_image",
                "reconstruct_capture",
                "localize_frame",
                "inspect_observation",
                "inspect_capture",
                "inspect_architecture",
                "publish_architecture",
                "move_architecture_object",
                "measure_architecture",
                "check_architecture_geometry",
                "inspect_architecture_accuracy",
                "fit_architecture_photo",
                "asset_authoring_contract",
                "create_mesh_asset",
                "import_model_asset",
                "search_model_assets",
                "inspect_model_asset",
                "download_model_asset",
                "object_reference_image",
                "refine_architecture",
                "propose_architecture_scale",
                "architecture_photo_overlay",
                "build_architecture_landmarks",
                "inspect_guidance_map",
                "inspect_architecture_materials",
                "preview_photo_material",
                "inspect_architecture_structure",
                "propose_architecture_structure",
                "preview_architecture_walkthrough",
            }
            result = await client.call_tool("list_maps", {})
            assert not result.is_error
            contract = await client.call_tool("asset_authoring_contract", {})
            assert not contract.is_error
            asset_search = await client.call_tool("search_model_assets", {"limit": 1})
            assert not asset_search.is_error
            invalid = await client.call_tool(
                "inspect_architecture", {"map_id": "invalid"}
            )
            assert invalid.is_error and "RoomTrace 404" in invalid.content[0].text
            ready = next(
                (job for job in store.list_jobs() if job["status"] == "ready"), None
            )
            if len(sys.argv) == 2:
                # Handoff replay only: the caller created this isolated test capture.
                target_id = sys.argv[1]
                target = store.get_job(target_id)
                assert ready and target["status"] == "awaiting_agent"
                captured = await client.call_tool(
                    "inspect_capture", {"map_id": target_id}
                )
                assert not captured.is_error
                evidence = json.loads(captured.content[0].text)
                assert "architecture_schema" in evidence
                frames = json.loads(
                    (store.job_dir(target_id) / "frames.json").read_text()
                )
                assert 4 <= len(frames) <= 12
                originals = json.loads(
                    (store.job_dir(ready["id"]) / "frames.json").read_text()
                )
                assert [f["name"] for f in frames] == [f["name"] for f in originals]
                for frame in frames:
                    photo = await client.call_tool(
                        "reference_image",
                        {"map_id": target_id, "filename": frame["name"]},
                    )
                    assert not photo.is_error and any(
                        c.type == "image" for c in photo.content
                    )
                document = json.loads(
                    (store.artifact_dir(ready) / "architecture.json").read_text()
                )
                for asset_id in {
                    e["asset_id"] for e in document["elements"] if e["kind"] == "asset"
                }:
                    asset = await client.call_tool(
                        "inspect_model_asset", {"asset_id": asset_id}
                    )
                    assert not asset.is_error
                # The geometry input is an existing agent-authored document for these
                # same photos, not a template or a substitute generation response.
                for material in document["photo_materials"]:
                    material["map_id"] = target_id
                    material["sha256"] = hashlib.sha256(
                        (
                            store.job_dir(target_id) / "images" / material["source"]
                        ).read_bytes()
                    ).hexdigest()
                    preview = await client.call_tool(
                        "preview_photo_material",
                        {"map_id": target_id, "material": material},
                    )
                    assert not preview.is_error and any(
                        c.type == "image" for c in preview.content
                    )
                request = {
                    "map_id": target_id,
                    "expected_revision": 0,
                    "document": document,
                }
                published = await client.call_tool("publish_architecture", request)
                assert not published.is_error
                saved = store.get_job(target_id)
                assert saved["status"] == "ready" and saved["revision"] == 1
                assert json.loads(
                    (store.artifact_dir(saved) / "architecture.json").read_text()
                ) == json.loads(Architecture.model_validate(document).model_dump_json())
                conflict = await client.call_tool("publish_architecture", request)
                assert conflict.is_error and "409" in conflict.content[0].text
                assert store.get_job(target_id)["revision"] == 1
                print(
                    f"PASS: {len(frames)}-photo MCP inspection, asset evidence, material previews, actual mesh publication and stale-revision rejection. Existing authored geometry replayed, not newly inferred."
                )
            if ready:
                scene = json.loads(
                    (store.artifact_dir(ready) / "scene.json").read_text()
                )
                inspected = await client.call_tool(
                    "inspect_map", {"map_id": ready["id"]}
                )
                assert not inspected.is_error
                if scene["mode"] == "architecture":
                    accuracy = await client.call_tool(
                        "inspect_architecture_accuracy", {"map_id": ready["id"]}
                    )
                    assert not accuracy.is_error
                    structure = await client.call_tool(
                        "inspect_architecture_structure", {"map_id": ready["id"]}
                    )
                    assert not structure.is_error
                    capture = await client.call_tool(
                        "inspect_capture", {"map_id": ready["id"]}
                    )
                    assert not capture.is_error
                    payload = json.loads(
                        next(c.text for c in capture.content if c.type == "text")
                    )
                    assert "refinement_schema" in payload
                    alignments = scene["architecture"].get("alignments", [])
                    if alignments:
                        overlay = await client.call_tool(
                            "architecture_photo_overlay",
                            {
                                "map_id": ready["id"],
                                "expected_revision": scene["revision"],
                                "source": alignments[0]["source"],
                            },
                        )
                        assert not overlay.is_error
                        assert any(
                            c.type == "image" and c.mime_type == "image/png"
                            for c in overlay.content
                        )
                        print(
                            "PASS: MCP correction schema and actual source-photo PNG overlay"
                        )
                photo = await client.call_tool(
                    "reference_image",
                    {"map_id": ready["id"], "filename": scene["frames"][0]["name"]},
                )
                assert not photo.is_error and any(
                    item.type == "image" for item in photo.content
                )
                print(
                    "PASS: MCP returns the actual saved map and a source image content block"
                )
                if any((store.job_dir(ready["id"]) / "queries").glob("*.json")):
                    observation = await client.call_tool(
                        "inspect_observation", {"map_id": ready["id"]}
                    )
                    assert not observation.is_error
                    evidence = json.loads(
                        next(
                            item.text
                            for item in observation.content
                            if item.type == "text"
                        )
                    )
                    picture = next(
                        item for item in observation.content if item.type == "image"
                    )
                    saved = (
                        store.job_dir(ready["id"]) / "queries" / evidence["query_id"]
                    )
                    assert (
                        evidence["result"]
                        == json.loads(saved.with_suffix(".json").read_text())["result"]
                    )
                    assert (
                        base64.b64decode(picture.data)
                        == saved.with_suffix(".jpg").read_bytes()
                    )
                    exact = await client.call_tool(
                        "inspect_observation",
                        {"map_id": ready["id"], "query_id": evidence["query_id"]},
                    )
                    assert not exact.is_error and exact.content == observation.content
                    print(
                        "PASS: latest and exact MCP observations pair the actual image with its saved pose evidence"
                    )
    print("PASS: MCP initialization, tool schemas, and actual HTTP map listing")


asyncio.run(main())

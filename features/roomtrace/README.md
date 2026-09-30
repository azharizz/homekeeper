# RoomTrace in HomeKeeper

Source imported from [RoomTrace](https://github.com/azharizz/photo_to_3d_model), commit `3a8d98f`. This directory is a self-contained Python geometry service and independently built React workspace. It does not depend on the former sibling checkout, Homebuddy, Pascal or any desktop modeling app. Research archives and historical screenshots stay in the original repository.

```text
app/api/           Uploads, geometry and asset endpoints
app/architecture/  Modeling contracts, geometry, evidence and walkthroughs
app/assets/        Immutable authored/imported GLB library
app/mcp_server.py  Real MCP stdio tools used by Codex
web/src/           Modeling workspace, served under /roomtrace/
tests/             Geometry, API, asset, camera and MCP checks
data/              Private captures, revisions and assets, ignored by Git
models/            Downloaded engine weights, ignored by Git
```

## Configuration

Run `npm run setup` from HomeKeeper. The feature reads the root `.env` and uses its `HOMEKEEPER_TOKEN`. HomeKeeper supplies that credential to the Python service; it is never sent to the browser. The host enforces the existing local host and same-origin request boundaries. The geometry service independently checks its access token, upload limits and revision conflicts.

`ROOMTRACE_PYTHON` selects the native interpreter. `ROOMTRACE_PORT` defaults to 8790. Set `ROOMTRACE_URL=http://127.0.0.1:<port>` if changing that port. `ROOMTRACE_DATA` can select a different absolute data directory. The Compose service is internal at `http://roomtrace:8000`. No additional inference deadline is added.

Setup adds `ROOMTRACE_UID` and `ROOMTRACE_GID` for Docker bind-mount ownership. Native and Docker runs use the same local capture and model-cache directories. Run one geometry service against that directory at a time.

Structured modeling works on CPU. MapAnything is a separate selectable engine and downloads its pinned weights when used. CPU/CUDA requirements are retained. The default Compose build uses CPU; for CUDA build the feature Dockerfile with `COMPUTE_PROFILE=cuda` and configure a genuine NVIDIA GPU runtime. No GPU execution is claimed from CPU tests.

Compose selects `linux/amd64` because the tested Open3D 0.19 release has no Linux ARM wheel. Docker Desktop on Apple Silicon runs that container through emulation. Native macOS execution uses the available macOS wheel. The dependency is kept pinned rather than silently replacing it with a version that failed the earlier fusion regression.

## Connect Codex MCP

Start HomeKeeper first. Register `app/mcp_server.py` with the Python interpreter that has the feature's requirements. The server loads the root `.env` and calls HomeKeeper's actual gateway by default. For a different HomeKeeper port set `ROOMTRACE_MCP_URL=http://127.0.0.1:<port>/roomtrace/api/` in the root `.env`.

Example Codex configuration, replacing the paths with this checkout's absolute paths:

```toml
[mcp_servers.roomtrace]
command = "/absolute/homekeeper/.venv/bin/python"
args = ["/absolute/homekeeper/features/roomtrace/app/mcp_server.py"]
```

When moving an existing RoomTrace registration, update both paths and restart the RoomTrace MCP connection in Codex Settings. An already running MCP process still uses its original command. See the [official MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Copy the modeling request from a capture into Codex. The real agent inspects the capture and source images, authors geometry/assets/materials and publishes with the current revision. The web page updates from the stored result. Captures and files supplied directly to MCP must live inside this feature directory. Authoring does not route through HomeKeeper's conversational Nebius agent.

## Checks

From HomeKeeper:

```sh
npm test
npm run build
npm run check:browser
npm run check:roomtrace
```

`check:roomtrace` starts real isolated services, checks gateway security and uploads, then inspects the integrated workspace in a browser. When local saved architecture exists it copies one capture and the asset library into temporary test storage, uploads those same photographs as a new capture and runs the actual MCP tool check. That check inspects the photos and asset evidence, previews source-linked materials, republishes the existing agent-authored document, and rejects a stale revision. The new model is rendered and downloaded through HomeKeeper. This is an integration replay, not newly inferred geometry or evidence of another room's accuracy. It does not edit the user's home. Without a saved capture, model-specific checks are reported as skipped.

Existing Python checks run from this directory, for example `python tests/check_structure.py` and `python tests/check_walkthrough.py`. `tests/check_mcp.py` expects HomeKeeper to be running. JavaScript geometry checks use `node tests/check_camera.mjs` and `node tests/check_walkthrough.mjs`.

Measurements and steps remain estimates unless genuine physical evidence supports them. The model walkthrough is not live phone positioning or a verified walking aid. Preserve [third-party notices](THIRD_PARTY_NOTICES.md) when redistributing the feature.

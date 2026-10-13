# RoomTrace in HomeKeeper

Source imported from [RoomTrace](https://github.com/azharizz/photo_to_3d_model), commit `3a8d98f`. This directory owns the Python geometry service. The native Spaces React page lives at `web/spaces/` in HomeKeeper’s single frontend build. It does not depend on the former sibling checkout, Homebuddy, Pascal or any desktop modeling app. Research archives and historical screenshots stay in the original repository.

```text
app/api/           Uploads, geometry and asset endpoints
app/architecture/  Modeling contracts, geometry, evidence and walkthroughs
app/assets/        Immutable authored/imported GLB library
app/mcp_server.py  Real MCP stdio tools used by Codex
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

Normal structured captures now run the installed COLMAP feature matching, triangulation and bundle adjustment before Codex authoring. `inspect_capture` exposes `capture_reconstruction`: observed per-source intrinsics, reprojection statistics, registered views and exact reconstruction failures. Supplied intrinsics retain their provenance; automatically recovered lenses are explicitly bundle-adjusted estimates, not measured calibration. Failed multi-view evidence does not invent cameras or block authoring an explicitly uncalibrated draft.

Architecture publication fits declared observed photo-to-model anchors. When those pixels identify actual reconstructed tracks, it verifies a positive similarity transform from the arbitrary COLMAP frame to the authored frame: at least four non-coplanar fitting tracks, two distinct held-out check tracks, at most 2% of the fitting-anchor span in 3D residual and the selected source-pixel threshold. Each photo alignment still needs six fitting points for its independent camera fit. The resulting revision-owned index uses the genuinely observed tracks/descriptors, excludes every check track and records the registration. Raw photos alone cannot identify authored wall/furniture anchors, obstacles or room connections. If registration cannot be verified, that exact failure is exposed; an independently valid declared-landmark index can still be used without importing reconstructed tracks. The declared path needs eight shared fitting landmarks in two views with depth variation and usable image descriptors. Missing calibration, insufficient observations, failed fitting or failed held-out projection checks leave explicit `needs_calibration` reasons, not fake readiness.

The existing capture form accepts an optional measured reference for photo captures: choose the same two textured endpoints in two overlapping source views, report metres, absolute uncertainty and who/what/instrument/date provenance. The API validates finite normalized coordinates, distinct views/endpoints, positive distance and uncertainty smaller than distance. Scale resolves only if both endpoint pairs identify the same two distinct triangulated tracks; otherwise `scale_failure` explains why scale stays unknown. After checked frame registration, `reported_scale.meters_per_model_unit` converts model lengths using that reported evidence. This does not silently resize authored geometry, certify physical clearance or claim sensor measurements; `physically_verified` remains false.

The scene API persists `guide_readiness`: `status` (`ready` or `needs_calibration`), `ready`, `reasons`, `revision`, `artifact_revision`, `landmark_count`, `camera_count`, and `validation`. Validation is `passed`, `failed`, or `missing`: declared check points are excluded from camera fitting and index training; missing checks are reported separately from index readiness. `localizable` means an actual revision-owned index exists, not that a live frame is localized. Units remain estimated metres and `physically_verified` is false; readiness never certifies scale, clearance or safe walking. The explicit landmark rebuild endpoint publishes a fresh revision and returns its readiness; use that returned revision for subsequent edits. Older revisions, including saved demo data, are never rewritten automatically.

## Mobile-web room recognition and recorded transitions

`POST /api/recognize` accepts multipart `image`, optional JSON `calibration`, optional finite `captured_at`, and optional JSON `candidate_ids` (one to eight distinct map IDs). It runs the existing descriptor matching and geometric pose verification against every eligible current architectural Space, never selecting the first named room. Eligibility requires ready calibration and the revision-owned localization index. A unique geometric match returns `status: recognized`, `map_id`, `revision`, and `localization` with the retained `query_id`; `unknown`, `ambiguous`, and `incomplete` return no accepted room or pose. Unknown calibration and stale artifacts have explicit exclusion reasons. The browser/session separately requires a fresh capture before binding a current room.

Search is bounded to eight eligible Spaces per frame. More than eight returns `incomplete` without a whole-house recognition claim. Restricting `candidate_ids` does not hide omitted eligible rooms: an unsearched eligible Space leaves the answer incomplete, even if one searched room matches. Concurrent changes to the eligible revision set also require another frame. No estimated sensor scale, cross-room camera transform or physical location is synthesized.

`GET /api/maps/{id}/connection-endpoints` exposes stable authored door/passage references and same-level authored `floor_ids`, not topology inferred from room names. `POST /api/room-connections` requires `a` and `b` endpoints, each with `map_id`, `revision`, `query_id`, `element_id`, `opening_id` and the exact slab `floor_id`, plus `user_confirmed: true` and nonblank observed-pair `evidence`. Both rooms must be calibrated/current, both retained images must exist, and their geometrically verified camera positions must lie above the selected modeled body-clear floor. A user must explicitly confirm these exact openings connect; the service does not infer that fact from image labels. These records retain the observed camera positions, **not invented doorway centers**, in separate connection metadata. Confirmed records survive observation-history pruning but become unusable on a room revision/calibration change.

`GET /api/room-connections` lists current links and excluded stale reasons. `GET /api/room-route?from_map_id=…&to_map_id=…` searches only recorded current links and returns ordered directed hops, `same_room`, or an explicit `unknown` missing-link reason. `POST /api/maps/{id}/connection-walkthrough` accepts `expected_revision`, `connection_id`, finite bounded `start: [x,z]` and optional body profile. It reuses the constrained floor-triangle planner to reach the recorded endpoint camera position without moving invalid starts/goals or crossing modeled obstacles. The route returns `target_id: connection_<id>`, `floor_id`, route points/distance and `transition_requires_recognition: true`. It stops in the source room: fresh unique recognition is required before continuing in the destination room. Neither recorded topology nor modeled approach proves physical doorway clearance, measured scale, safe passage or arrival.

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

`python tests/check_automatic_calibration.py` runs the focused publication/calibration mock check in temporary storage with Aria-shaped frame names and synthetic correspondences; it never reads or changes a saved Space or demo media and does not start an HTTP service.
`python tests/check_recognition.py` uses temporary mock Spaces and synthetic image features while running the actual localizer's FLANN/PnP verification and floor planner. It checks unique/ambiguous/unknown recognition, bounded incomplete searches, explicit connection validation, obstacle-aware point approaches and stale-link rejection. It never starts a service or accesses saved demo data; it is not hardware or physical-navigation proof.


`python tests/check_capture_calibration.py` exercises normal capture dispatch with mock COLMAP reconstruction inputs, observed track/model registration, held-out track exclusion, reported measurement validation and absent-evidence refusal in new temporary captures. It never runs reconstruction on saved media, starts a service or claims a hardware trial.

Measurements and steps remain estimates unless genuine physical evidence supports them. The model walkthrough is not live phone positioning or a verified walking aid. Preserve [third-party notices](THIRD_PARTY_NOTICES.md) when redistributing the feature.

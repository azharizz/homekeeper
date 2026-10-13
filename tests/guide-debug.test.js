import test from "node:test";
import assert from "node:assert/strict";
import { currentGuidePose, currentGuideRoute } from "../web/guide-debug-state.js";
import { GUIDE_POSE_MAX_AGE } from "../web/guide-tracking.js";

test("debug POV uses only fresh same-model camera or XR poses and clears on loss", () => {
  const scene = { id: "kitchen", revision: 2 };
  const pose = { status: "tracking", source: "camera", mapId: scene.id, revision: 2, capturedAt: 100, position: [1, 1.6, 3], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
  assert.equal(currentGuidePose(pose, scene, 100), pose);
  assert.equal(currentGuidePose(pose, scene, 100 + GUIDE_POSE_MAX_AGE), pose);
  const xr = { ...pose, source: "webxr" };
  assert.equal(currentGuidePose(xr, scene, 100), xr);
  for (const change of [
    { status: "lost" }, { status: "aligning" }, { status: "stopped" },
    { source: "synthetic" }, { mapId: "bedroom" }, { revision: 1 },
    { capturedAt: 100.01 }, { capturedAt: null }, { capturedAt: NaN },
    { position: null }, { position: [1, 2] }, { position: [0, Infinity, 0] },
    { quaternion: [0, 0, 0, 0] }, { quaternion: [0, 0, NaN, 1] },
  ]) assert.equal(currentGuidePose({ ...pose, ...change }, scene, 100), null);
  assert.equal(currentGuidePose(pose, scene, 100 + GUIDE_POSE_MAX_AGE + 0.01), null);
  assert.equal(currentGuidePose(pose, scene, 100, true), null);
  assert.equal(currentGuidePose(pose, { ...scene, revision: 3 }, 100), null);
  assert.equal(currentGuidePose(null, scene, 100), null);
  assert.equal(currentGuidePose(pose, null, 100), null);
});

test("debug paths cannot carry an obsolete model revision, target, or floor", () => {
  const scene = { id: "kitchen", revision: 2 };
  const target = { elementId: "cupboard", floorId: "ground" };
  const route = { revision: 2, target_id: "cupboard", floor_id: "ground", distance_m: 2, points: [[0, 0, 0], [2, 0, 0]], target_position: [2.5, 1, 0] };
  assert.equal(currentGuideRoute(route, scene, target), route);
  for (const change of [
    { revision: 1 }, { target_id: "table" }, { floor_id: "upstairs" },
    { map_id: "bedroom" },
    { distance_m: NaN }, { distance_m: -1 }, { points: [] },
    { points: [[0, 0, Infinity]] }, { target_position: null },
  ]) assert.equal(currentGuideRoute({ ...route, ...change }, scene, target), null);
  assert.equal(currentGuideRoute(route, scene, null), null);
});

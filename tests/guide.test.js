import test from "node:test";
import assert from "node:assert/strict";
import { matchMessage } from "../web/guide-status.js";
import { validateGuideImage, validateGuideContext, callGuideTool, guideTools, nextGuideInstruction, computeGuideGuidance, resolveGuideLocation } from "../alexa_host/guide.js";

test("guide never treats missing, stale or mismatched observations as a current match", () => {
  const match = { status: "localized", map_revision: 2, captured_at: 95, display_position: [1, 2, 3] };
  assert.match(matchMessage(match, 2, 2, 100), /unverified model estimate/);
  for (const change of [{ status: "lost" }, { map_revision: 1 }, { captured_at: 89 }, { captured_at: 101 }, { captured_at: null }, { display_position: [NaN, 0, 0] }]) {
    assert.match(matchMessage({ ...match, ...change }, 2, 2, 100), /^Position unknown/);
  }
  assert.match(matchMessage(match, 2, 3, 100), /^Position unknown/);
});

test("guide camera accepts only fresh, bounded JPEG data URLs on new guide messages", () => {
  const dataUrl = bytes => `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const image = { data_url: dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])), captured_at: 100 };
  const input = { guide: true, message: "Describe this stationary view", image };
  assert.deepEqual(validateGuideImage(input, 100), image);
  assert.deepEqual(validateGuideImage({ ...input, image: { ...image, captured_at: 90 } }, 100), { ...image, captured_at: 90 });
  assert.equal(validateGuideImage({ guide: true, message: "Recall my keys" }, 100), undefined);
  for (const change of [{ guide: false }, { guide: undefined }, { message: undefined }, { message: " " }, { decision: false }, { retry: true }])
    assert.throws(() => validateGuideImage({ ...input, ...change }, 100), /new Home Guide message/);
  for (const captured_at of [89.999, 100.001, -1, NaN, Infinity, "100", null])
    assert.throws(() => validateGuideImage({ ...input, image: { ...image, captured_at } }, 100));
  for (const invalid of [
    null, {}, { ...image, url: "https://example.com/private.jpg" },
    { ...image, data_url: "https://example.com/private.jpg" },
    { ...image, data_url: image.data_url.replace("image/jpeg", "image/png") },
    { ...image, data_url: "data:image/jpeg;base64," },
    { ...image, data_url: "data:image/jpeg;base64,%%%=" },
    { ...image, data_url: "data:image/jpeg;base64,/9j/2R==" },
    { ...image, data_url: dataUrl(Buffer.from("not a JPEG")) },
    { ...image, data_url: dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0x00])) },
  ]) assert.throws(() => validateGuideImage({ ...input, image: invalid }, 100));
  const bytes = Buffer.alloc(1024 * 1024);
  bytes.set([0xff, 0xd8, 0xff]);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  assert.equal(validateGuideImage({ ...input, image: { ...image, data_url: dataUrl(bytes) } }, 100).captured_at, 100);
  assert.throws(() => validateGuideImage({ ...input, image: { ...image, data_url: dataUrl(Buffer.concat([bytes, Buffer.from([0xd9])])) } }, 100), /at most 1 MiB/);
});

test("guide tracking is finite, fresh, revision-bound and limited to a new guide turn", () => {
  const space = { id: "a".repeat(32), revision: 2 };
  const context = { map_id: space.id, revision: 2, status: "tracking", source: "camera", captured_at: 100, position: [1, 2, 3], quaternion: [0, 0, 0, 1] };
  const input = { guide: true, message: "Where is my saved cabinet?", guide_context: context };
  assert.deepEqual(validateGuideContext(input, space, 100), context);
  assert.equal(validateGuideContext({ guide: true, message: "Next turn" }, space, 100), undefined);
  assert.deepEqual(validateGuideContext({ ...input, guide_context: { ...context, source: "webxr", captured_at: 95 } }, space, 100), { ...context, source: "webxr", captured_at: 95 });
  for (const status of ["lost", "aligning", "stopped", "unsupported"])
    assert.equal(validateGuideContext({ ...input, guide_context: { ...context, status, position: null, quaternion: null } }, space, 100).status, status);
  for (const change of [{ guide: false }, { guide: undefined }, { message: "" }, { message: undefined }, { retry: true }, { decision: false }])
    assert.throws(() => validateGuideContext({ ...input, ...change }, space, 100), /new Home Guide message/);
  for (const change of [
    { map_id: "b".repeat(32) }, { revision: 1 }, { revision: 2.5 },
    { captured_at: 94.999 }, { captured_at: 100.001 }, { captured_at: NaN },
    { position: [NaN, 0, 0] }, { position: [1, 2] }, { position: null },
    { quaternion: [0, 0, 0, 0] }, { quaternion: [0, 0, 0, Infinity] }, { quaternion: ["0", 0, 0, 1] },
    { status: "lost" }, { source: "invented" }, { trusted: true },
  ]) assert.throws(() => validateGuideContext({ ...input, guide_context: { ...context, ...change } }, space, 100));
  assert.throws(() => validateGuideContext(input, undefined, 100), /selected room/);
});

test("guide targets require real model elements and saved links; routes never invent a start", async (t) => {
  const mapId = "a".repeat(32);
  const itemId = "11111111-1111-4111-8111-111111111111";
  const containerId = "22222222-2222-4222-8222-222222222222";
  const scene = { mode: "architecture", revision: 2, name: "Kitchen", architecture: { levels: [{ id: 0, elevation: 0 }, { id: 1, elevation: 3 }], elements: [
    { id: "floor", kind: "slab", level: 0, top: 0, label: "Floor" },
    { id: "upstairs", kind: "slab", level: 1, top: 0, label: "Upstairs" },
    { id: "cabinet", kind: "box", level: 0, label: "Cabinet" },
  ] } };
  const requests = [];
  let routeData = { revision: 2, floor_id: "floor", target_id: "cabinet", distance_m: 3, points: [[1, 0, 3], [4, 0, 3]] };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.endsWith("/scene") ? scene : routeData };
  });
  const session = { guideSpace: { id: mapId, revision: 2 } };
  const home = { assets: [{ id: itemId, name: "Keys" }, { id: containerId, name: "Cabinet" }],
    space_objects: [{ space_id: mapId, element_id: "cabinet", revision: 2, asset_id: containerId }],
    memories: [{ asset_id: itemId, kind: "location", space_id: mapId, element_id: "cabinet", space_revision: 2, content: "In the top drawer" }] };
  const args = { target_id: "cabinet", floor_id: "floor", asset_id: itemId };
  assert.ok(guideTools.every(tool => tool.annotations.readOnlyHint === true));
  assert.deepEqual(await callGuideTool({}, session, "set_guide_target", args, { home }),
    { elementId: "cabinet", floorId: "floor", label: "Cabinet", assetId: itemId });
  assert.equal(session.guideTarget.assetId, itemId, "Stored thing need not be the linked container identity");
  assert.equal((await callGuideTool({}, session, "set_guide_target", { ...args, asset_id: containerId }, { home })).assetId, containerId);
  for (const change of [{ target_id: "guessed" }, { floor_id: "upstairs" }, { target_id: "floor" }])
    await assert.rejects(callGuideTool({}, session, "set_guide_target", { ...args, ...change }, { home }), /existing destination/);
  await assert.rejects(callGuideTool({}, session, "set_guide_target", args, { home: { ...home, memories: [] } }), /no current saved location/);
  await assert.rejects(callGuideTool({}, session, "set_guide_target", args, { home: { ...home, memories: [{ ...home.memories[0], space_revision: 1 }] } }), /no current saved location/);
  await assert.rejects(callGuideTool({}, session, "set_guide_target", args, { home: { ...home, assets: [] } }), /no current saved location/);
  const routeArgs = { target_id: "cabinet", floor_id: "floor" };
  await assert.rejects(callGuideTool({}, session, "rehearse_guide_route", routeArgs), /position is unknown/);
  await assert.rejects(callGuideTool({}, session, "rehearse_guide_route", { ...routeArgs, x: 1 }), /both virtual/);
  const context = { map_id: mapId, revision: 2, status: "tracking", source: "camera", captured_at: Date.now() / 1000, position: [1, 2, 3], quaternion: [0, 0, 0, 1] };
  const route = await callGuideTool({}, session, "rehearse_guide_route", routeArgs, { context });
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).start, [1, 3]);
  assert.equal(route.distance_m, 3);
  assert.equal(route.physical_path_verified, false);
  assert.equal(route.guidance.action, "right");
  assert.equal(route.guidance.remaining_distance_m, 3);
  assert.match(route.guidance.instruction, /^Model estimate:/);
  assert.ok(!("points" in route) && !("start" in route), "Raw sensor position must not enter saved tool history");
  for (const change of [{ captured_at: context.captured_at - 6 }, { revision: 1 }, { map_id: "b".repeat(32) }, { status: "lost", position: null, quaternion: null }])
    await assert.rejects(callGuideTool({}, session, "rehearse_guide_route", routeArgs, { context: { ...context, ...change } }));
  await callGuideTool({}, session, "rehearse_guide_route", { ...routeArgs, x: 8, z: 9 });
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).start, [8, 9]);
  const validRoute = routeData;
  for (const change of [{ revision: 1 }, { floor_id: "upstairs" }, { target_id: "guessed" }, { distance_m: NaN }, { distance_m: -1 }]) {
    routeData = { ...validRoute, ...change };
    await assert.rejects(callGuideTool({}, session, "rehearse_guide_route", { ...routeArgs, x: 8, z: 9 }), /matching model route/);
  }
  routeData = validRoute;
  scene.revision = 3;
  await assert.rejects(callGuideTool({}, session, "rehearse_guide_route", routeArgs, { context }), /model changed/);
  assert.equal(session.guideTarget, undefined);
  await callGuideTool({}, session, "read_guide_room", { map_id: mapId });
  assert.equal(session.guideSpace.revision, 3);
  assert.ok(requests.every(entry => entry.url.includes("/maps/") && !entry.url.includes("/actions/")), "Guide tools never write household records");
});

const ariaShape = () => ({
  mode: "architecture", revision: 4, name: "Mock living room",
  guide_readiness: { ready: true, physically_verified: false },
  architecture: { levels: [{ id: "ground", elevation: 0 }, { id: "upper", elevation: 3 }], elements: [
    { id: "floor", kind: "slab", level: "ground", top: 0 },
    { id: "upper-floor", kind: "slab", level: "upper", top: 0 },
    { id: "coffee-table", kind: "box", level: "ground", label: "Coffee table", center: [0.4, 0.2, -0.43], size: [1.1, 0.4, 0.55] },
    { id: "cabinet", kind: "box", level: "ground", label: "Cabinet", center: [2.1, 0.8, -2.2], size: [0.7, 1.6, 0.5] },
  ] },
});
const mockSpace = { id: "c".repeat(32), revision: 4 };
const mockPose = (position, quaternion = [0, 0, 0, 1]) => ({
  map_id: mockSpace.id, revision: 4, status: "tracking", source: "camera",
  captured_at: 100, position, quaternion,
});
const mockRoute = (target, points) => ({
  map_id: mockSpace.id, revision: 4, floor_id: "floor", target_id: target,
  points, distance_m: points.slice(1).reduce((sum, point, i) =>
    sum + Math.hypot(point[0] - points[i][0], point[2] - points[i][2]), 0),
});

test("closed-loop mocked Aria-shaped routes recompute orientation, corners and model arrival", () => {
  const target = { elementId: "coffee-table", floorId: "floor" };
  const route = mockRoute(target.elementId, [[-1.3, 0, 0.8], [0.4, 0, 0.8], [0.4, 0, 0.25]]);
  const pose = mockPose([-1.3, 1.6, 0.8]);
  const right = nextGuideInstruction(mockSpace, target, pose, route, 100);
  assert.equal(right.action, "right");
  assert.equal(right.turn_degrees, 90);
  assert.ok(Math.abs(right.next_segment_distance_m - 1.7) < 1e-12);
  assert.ok(Math.abs(right.remaining_distance_m - 2.25) < 1e-12);
  assert.equal(right.physical_path_verified, false);
  assert.ok(!("steps" in right) && !("position" in right));
  const facingSegment = mockPose(pose.position, [0, -Math.SQRT1_2, 0, Math.SQRT1_2]);
  assert.equal(nextGuideInstruction(mockSpace, target, facingSegment, route, 100).action, "ahead", "Stationary heading changes must update the instruction");
  const otherTarget = { elementId: "cabinet", floorId: "floor" };
  const otherStart = mockPose([3.4, 1.6, -2.2]);
  const otherRoute = mockRoute(otherTarget.elementId, [[3.4, 0, -2.2], [2.8, 0, -2.2]]);
  assert.equal(nextGuideInstruction(mockSpace, otherTarget, otherStart, otherRoute, 100).action, "left");
  const cornerPose = mockPose([0.4, 1.6, 0.8], facingSegment.quaternion);
  const cornerRoute = mockRoute(target.elementId, [[0.4, 0, 0.8], [0.4, 0, 0.25]]);
  assert.equal(nextGuideInstruction(mockSpace, target, cornerPose, cornerRoute, 100).action, "left");
  const end = [0.4, 0, 0.25];
  const arrival = nextGuideInstruction(mockSpace, target, mockPose([end[0], 1.6, end[2]]),
    mockRoute(target.elementId, [end, end]), 100);
  assert.equal(arrival.status, "arrived");
  assert.equal(arrival.remaining_distance_m, 0);
  assert.match(arrival.instruction, /Model estimate.*approach point/);
  for (const change of [
    { captured_at: 94.99 }, { captured_at: 100.01 }, { revision: 3 }, { map_id: "d".repeat(32) },
    { status: "lost", position: null, quaternion: null },
  ]) {
    const cleared = nextGuideInstruction(mockSpace, target, { ...pose, ...change }, route, 100);
    assert.equal(cleared.status, "lost");
    assert.equal(cleared.instruction, null);
    assert.equal(cleared.remaining_distance_m, null);
  }
  for (const change of [
    { revision: 3 }, { map_id: "d".repeat(32) }, { floor_id: "upper-floor" },
    { target_id: "cabinet" }, { points: [] }, { distance_m: 1 },
    { points: [[-1.3, 0, 0.8], [0.4, 3, 0.8]] },
  ]) assert.equal(nextGuideInstruction(mockSpace, target, pose, { ...route, ...change }, 100).instruction, null);
  assert.equal(nextGuideInstruction(mockSpace, target, mockPose([5, 1.6, 5]), route, 100).instruction, null);
});

test("continuous guide uses fresh poses and authoritative targets through mocked walkthrough only", async (t) => {
  const scene = ariaShape(), requests = [];
  const session = { guideSpace: { ...mockSpace }, guideTarget: { elementId: "coffee-table", floorId: "floor" } };
  let responseChange = {}, expire = false, now = 100;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/scene")) return { ok: true, json: async () => scene };
    const body = JSON.parse(options.body), [x, z] = body.start;
    const end = body.target_id === "cabinet" ? [2.8, 0, -2.2] : [0.4, 0, 0.25];
    if (expire) now = 106;
    return { ok: true, json: async () => ({ ...mockRoute(body.target_id, [[x, 0, z], end]), ...responseChange }) };
  });
  const options = { now: () => now }, pose = mockPose([-1.3, 1.6, 0.8]);
  const first = await computeGuideGuidance({}, session, pose, options);
  assert.equal(first.guidance.status, "tracking");
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).start, [-1.3, 0.8]);
  assert.deepEqual(Object.keys(session).sort(), ["guideSpace", "guideTarget"], "No pose, route or progress is persisted");
  session.guideTarget = { elementId: "cabinet", floorId: "floor" };
  const second = await computeGuideGuidance({}, session, mockPose([3.4, 1.6, -2.2]), options);
  assert.equal(second.guidance.action, "left");
  assert.equal(second.route.target_id, "cabinet");
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).start, [3.4, -2.2]);
  for (const context of [undefined, { ...pose, captured_at: 94 }, { ...pose, status: "lost", position: null, quaternion: null }, mockPose([-1.3, 3.6, 0.8]), mockPose([-1.3, -0.1, 0.8])]) {
    const before = requests.filter(entry => entry.url.endsWith("/walkthrough")).length;
    const cleared = await computeGuideGuidance({}, session, context, options);
    assert.equal(cleared.route, null);
    assert.equal(cleared.guidance.status, "lost");
    assert.equal(cleared.guidance.remaining_distance_m, null);
    assert.equal(requests.filter(entry => entry.url.endsWith("/walkthrough")).length, before);
  }
  scene.guide_readiness.ready = false;
  assert.equal((await computeGuideGuidance({}, session, pose, options)).guidance.instruction, null);
  scene.guide_readiness.ready = true;
  responseChange = { floor_id: "upper-floor" };
  assert.equal((await computeGuideGuidance({}, session, pose, options)).route, null);
  responseChange = {};
  expire = true;
  assert.equal((await computeGuideGuidance({}, session, pose, options)).guidance.status, "lost", "Tracking is checked again after route latency");
  now = 100; expire = false;
  session.guideTarget = { elementId: "missing", floorId: "floor" };
  assert.equal((await computeGuideGuidance({}, session, pose, options)).guidance.status, "no_target");
  assert.equal(session.guideTarget, undefined);
  session.guideTarget = { elementId: "cabinet", floorId: "floor" };
  scene.revision = 5;
  assert.equal((await computeGuideGuidance({}, session, pose, options)).route, null);
  assert.equal(session.guideTarget, undefined);
  assert.ok(requests.every(entry => entry.url.endsWith("/scene") || entry.url.endsWith("/walkthrough")));
});

test("location text nominates exact current room/container records without guessing or saving", () => {
  const scene = { id: "a".repeat(32), name: "Kitchen", revision: 2, architecture: { elements: [
    { id: "floor", kind: "slab", level: 0, label: "Floor" },
    { id: "cabinet", kind: "box", level: 0, label: "Cabinet" },
  ] } };
  const memory = { id: "11111111-1111-4111-8111-111111111111", revision: 3, asset_id: "22222222-2222-4222-8222-222222222222", title: "Keys", content: "In the Kitchen Cabinet" };
  const before = JSON.stringify(memory);
  const resolved = resolveGuideLocation(memory, [scene]);
  assert.equal(resolved.status, "confirmation_required");
  assert.equal(resolved.saved, false);
  assert.deepEqual(resolved.candidates, [{
    space_id: scene.id, element_id: "cabinet", space_revision: 2, space_name: "Kitchen",
    element_label: "Cabinet", floor_id: "floor", route_supported: true, reason: "text_container_match",
  }]);
  assert.equal(JSON.stringify(memory), before);
  const other = { ...scene, id: "b".repeat(32), name: "Bedroom" };
  assert.equal(resolveGuideLocation({ ...memory, content: "In the cabinet" }, [scene, other]).status, "ambiguous");
  assert.equal(resolveGuideLocation(memory, [scene, other]).candidates.length, 1, "Explicit room, not first room, disambiguates containers");
  assert.equal(resolveGuideLocation(memory, [{ ...scene, architecture: { elements: [...scene.architecture.elements, { id: "cabinet2", kind: "box", level: 0, label: "Cabinet" }] } }]).status, "ambiguous");
  assert.equal(resolveGuideLocation({ ...memory, content: "In the Kitchen" }, [scene]).candidates[0].route_supported, false);
  assert.equal(resolveGuideLocation({ ...memory, content: "In a cabin" }, [scene]).status, "missing_evidence");
  assert.equal(resolveGuideLocation(memory, [scene], { missingModels: [other.id] }).status, "incomplete_evidence");
  const anchored = { ...memory, space_id: scene.id, element_id: "cabinet", space_revision: 1 };
  assert.equal(resolveGuideLocation(anchored, [scene, other]).status, "reconfirmation_required");
  assert.equal(resolveGuideLocation(anchored, [scene, other]).candidates.length, 1);
  assert.equal(resolveGuideLocation({ ...anchored, space_revision: 2 }, [scene]).status, "current");
  assert.equal(resolveGuideLocation({ ...anchored, element_id: "removed", content: "Unknown drawer" }, [scene]).status, "missing_anchor");
});

test("mocked saved-location resolution reads evidence without selecting or writing a target", async (t) => {
  const mapId = "a".repeat(32), memoryId = "11111111-1111-4111-8111-111111111111";
  const assetId = "22222222-2222-4222-8222-222222222222";
  const scene = { id: mapId, mode: "architecture", name: "Kitchen", revision: 2, architecture: { elements: [
    { id: "floor", kind: "slab", level: 0, label: "Floor" },
    { id: "cabinet", kind: "box", level: 0, label: "Cabinet" },
  ] } };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.endsWith("/maps") ? [{ id: mapId, status: "ready", options: { engine: "architecture" } }] : scene };
  });
  const home = { assets: [{ id: assetId, name: "Keys" }], memories: [{
    id: memoryId, revision: 1, asset_id: assetId, kind: "location", title: "Keys", content: "In the kitchen cabinet",
  }] };
  const before = JSON.stringify(home), session = {};
  const resolution = await callGuideTool({}, session, "resolve_guide_location", { memory_id: memoryId }, { home });
  assert.deepEqual(session.guideLocationResolution, resolution);
  assert.equal(session.guideTarget, undefined);
  assert.equal(session.guideSpace, undefined);
  assert.equal(JSON.stringify(home), before);
  assert.ok(requests.every(request => request.options.method === "GET"));
  session.guideSpace = { id: mapId, revision: 2 };
  await assert.rejects(callGuideTool({}, session, "set_guide_target", { asset_id: assetId, target_id: "cabinet", floor_id: "floor" }, { home }), /no current saved location/);
  home.memories[0] = { ...home.memories[0], ...resolution.candidates[0] };
  assert.equal((await callGuideTool({}, session, "set_guide_target", { asset_id: assetId, target_id: "cabinet", floor_id: "floor" }, { home })).assetId, assetId);
});

test("fresh still item reports remain separate from saved locations, including replay and expiry", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const home = { assets: [{ id: assetId, name: "Keys" }], memories: [{ kind: "location", asset_id: assetId, content: "In the drawer" }] };
  const image = { data_url: "data:image/jpeg;base64,/9j/4P/Z", captured_at: 100 };
  const args = { asset_id: assetId, description: "An item resembling the keys is visible beside a cup in this image.", captured_at: 100 };
  const before = JSON.stringify(home), session = {};
  const observation = await callGuideTool({}, session, "report_guide_item_observation", args, { home, image, now: () => 100 });
  assert.equal(observation.evidence, "current_camera_still");
  assert.equal(observation.saved, false);
  assert.equal(observation.movement_verified, false);
  assert.equal(observation.placement_verified, false);
  assert.deepEqual(observation.saved_locations, home.memories);
  assert.equal(JSON.stringify(home), before);
  assert.deepEqual(session, {});
  assert.equal((await callGuideTool({}, session, "report_guide_item_observation", args, { home, image, replay: { id: "aria-dino" }, now: () => 100 })).evidence, "prerecorded_still");
  await assert.rejects(callGuideTool({}, session, "report_guide_item_observation", args, { home }), /fresh still/);
  await assert.rejects(callGuideTool({}, session, "report_guide_item_observation", { ...args, captured_at: 99 }, { home, image }), /fresh still/);
  await assert.rejects(callGuideTool({}, session, "report_guide_item_observation", args, { home, image, now: () => 111 }), /ten seconds/);
  await assert.rejects(callGuideTool({}, session, "report_guide_item_observation", args, { home: { ...home, assets: [] }, image }), /existing household item/);
});

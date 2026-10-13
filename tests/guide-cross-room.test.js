import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../alexa_host/agent.js";
import { computeGuideGuidance } from "../alexa_host/guide.js";

const currentRoom = { id: "a".repeat(32), revision: 2, name: "Kitchen" };
const destinationRoom = { id: "b".repeat(32), revision: 7, name: "Bedroom" };
const savedTarget = { elementId: "cabinet", floorId: "bedroom-floor", label: "Cabinet" };
const connectionId = "fixture-doorway";
const doorwayTarget = { elementId: `connection_${connectionId}`, floorId: "floor", label: "Recorded doorway approach" };
const pose = () => ({ map_id: currentRoom.id, revision: currentRoom.revision, status: "tracking",
  source: "camera", captured_at: 100, position: [1, 1.6, 2], quaternion: [0, 0, 0, 1] });
const fixture = () => ({
  session: { guideSpace: { ...currentRoom }, guideDestination: { ...savedTarget, mapId: destinationRoom.id, revision: destinationRoom.revision } },
  scene: { id: currentRoom.id, mode: "architecture", revision: currentRoom.revision, guide_readiness: { ready: true },
    architecture: { levels: [{ id: "ground", elevation: 0 }], elements: [{ id: "floor", kind: "slab", level: "ground", top: 0 }] } },
  graph: { status: "connected", hops: [{ connection_id: connectionId,
    from: { map_id: currentRoom.id, revision: currentRoom.revision, floor_id: "floor" },
    to: { map_id: destinationRoom.id, revision: destinationRoom.revision, floor_id: savedTarget.floorId } }] },
  route: { map_id: currentRoom.id, revision: currentRoom.revision, floor_id: "floor", target_id: doorwayTarget.elementId,
    points: [[1, 0, 2], [1, 0, 0]], distance_m: 2 },
});

function mockRoomtrace(t, data, { afterRoute, graphUnavailable = false } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    requests.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
    if (path === `/api/maps/${currentRoom.id}/scene`) return { ok: true, json: async () => data.scene };
    if (path === `/api/room-route?from_map_id=${currentRoom.id}&to_map_id=${destinationRoom.id}`)
      return graphUnavailable ? { ok: false, status: 503 } : { ok: true, json: async () => data.graph };
    assert.equal(path, `/api/maps/${currentRoom.id}/connection-walkthrough`, "Only recorded doorway routing may be requested");
    afterRoute?.();
    return { ok: true, json: async () => data.route };
  });
  return requests;
}

function assertUnknown(result, status) {
  assert.equal(result.route, null);
  assert.equal(result.guidance.status, status);
  assert.equal(result.guidance.instruction, null);
  assert.equal(result.guidance.remaining_distance_m, null);
  assert.equal(result.guidance.next_segment_distance_m, null);
  assert.equal(result.guidance.turn_degrees, null);
  assert.equal(result.guidance.physical_path_verified, false);
}

test("cross-room destination routes only to the current room's recorded doorway approach", async (t) => {
  const data = fixture(), before = JSON.stringify(data.session);
  const requests = mockRoomtrace(t, data);
  const result = await computeGuideGuidance({}, data.session, pose(), { now: () => 100 });
  assert.equal(result.guidance.status, "tracking");
  assert.equal(result.guidance.action, "ahead");
  assert.equal(result.guidance.remaining_distance_m, 2);
  assert.equal(result.guidance.physical_path_verified, false);
  assert.deepEqual(result.target, doorwayTarget);
  assert.deepEqual(result.route, data.route);
  assert.deepEqual(requests.map(request => request.method), ["GET", "GET", "POST"]);
  assert.deepEqual(requests.at(-1).body, { expected_revision: 2, connection_id: connectionId, start: [1, 2] });
  assert.equal(JSON.stringify(data.session), before, "Routing must preserve the saved destination without persisting pose or progress");

  data.route = { ...data.route, points: [[1, 0, 2]], distance_m: 0 };
  const arrival = await computeGuideGuidance({}, data.session, pose(), { now: () => 100 });
  assert.equal(arrival.guidance.status, "arrived");
  assert.equal(arrival.guidance.action, "model_arrival");
  assert.match(arrival.guidance.instruction, /recorded doorway approach.*other room must be recognized.*clearance is unknown/);
  assert.equal(arrival.guidance.physical_path_verified, false);
  assert.equal(data.session.guideTarget, undefined, "Reaching a doorway does not bind the destination room or its target");
  assert.equal(data.session.guideSpace.id, currentRoom.id);
});

test("cross-room guidance rejects stale, foreign and missing poses before contacting RoomTrace", async (t) => {
  const data = fixture(), requests = mockRoomtrace(t, data);
  for (const context of [undefined, { ...pose(), captured_at: 94.99 }, { ...pose(), captured_at: 100.01 },
    { ...pose(), revision: 1 }, { ...pose(), map_id: destinationRoom.id },
    { ...pose(), status: "lost", position: null, quaternion: null }]) {
    assertUnknown(await computeGuideGuidance({}, data.session, context, { now: () => 100 }), "lost");
  }
  assert.equal(requests.length, 0);
});

test("cross-room guidance rejects stale model and connection revisions without calculating a route", async (t) => {
  const data = fixture(), requests = mockRoomtrace(t, data);
  data.scene.revision++;
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  data.scene.revision = currentRoom.revision;
  data.graph.hops[0].from.revision--;
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  data.graph.hops[0].from.revision = currentRoom.revision;
  data.graph.hops[0].from.map_id = destinationRoom.id;
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  assert.ok(requests.every(request => !request.path.endsWith("/connection-walkthrough")));
});

test("cross-room guidance has no route when the recorded graph is unavailable or disconnected", async (t) => {
  const data = fixture(), requests = mockRoomtrace(t, data, { graphUnavailable: true });
  const unavailable = await computeGuideGuidance({}, data.session, pose(), { now: () => 100 });
  assertUnknown(unavailable, "unavailable");
  assert.match(unavailable.guidance.reason, /503/);
  assert.ok(requests.every(request => !request.path.endsWith("/connection-walkthrough")));
});

test("cross-room guidance rejects a graph ending at a foreign or revised saved destination", async (t) => {
  const data = fixture(), requests = mockRoomtrace(t, data), originalArrival = data.graph.hops[0].to;
  for (const change of [{ revision: destinationRoom.revision + 1 }, { map_id: currentRoom.id }]) {
    data.graph.hops[0].to = { ...originalArrival, ...change };
    const result = await computeGuideGuidance({}, data.session, pose(), { now: () => 100 });
    assertUnknown(result, "unavailable");
    assert.match(result.guidance.reason, /saved destination model changed/i);
  }
  assert.ok(requests.every(request => !request.path.endsWith("/connection-walkthrough")));
  assert.equal(data.session.guideDestination.revision, destinationRoom.revision);
});

test("cross-room guidance does not infer an unrecorded doorway or use an uncalibrated floor", async (t) => {
  const data = fixture(), requests = mockRoomtrace(t, data), graph = data.graph;
  for (const missingGraph of [{ status: "unknown", hops: [] }, { status: "connected", hops: [] }]) {
    data.graph = missingGraph;
    assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  }
  data.graph = graph;
  data.scene.guide_readiness.ready = false;
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  data.scene.guide_readiness.ready = true;
  data.graph.hops[0].from.floor_id = "unrecorded-floor";
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  data.graph.hops[0].from.floor_id = "floor";
  assertUnknown(await computeGuideGuidance({}, data.session, { ...pose(), position: [1, -0.1, 2] }, { now: () => 100 }), "unavailable");
  assert.ok(requests.every(request => !request.path.endsWith("/connection-walkthrough")));
});

test("cross-room guidance discards mismatched and geometrically invalid doorway routes", async (t) => {
  const data = fixture(), originalRoute = data.route;
  mockRoomtrace(t, data);
  for (const change of [{ revision: 1 }, { map_id: destinationRoom.id }, { floor_id: "other-floor" },
    { target_id: savedTarget.elementId }, { points: [] }, { distance_m: 3 },
    { points: [[0, 0, 2], [0, 0, 0]] }, { points: [[1, 0, 2], [1, 1, 0]] },
    { points: [[1, 0, 2], [1, 0, NaN]] }]) {
    data.route = { ...originalRoute, ...change };
    assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  }
});

test("cross-room guidance rechecks pose freshness after route latency", async (t) => {
  const data = fixture();
  let now = 100;
  mockRoomtrace(t, data, { afterRoute: () => { now = 106; } });
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => now }), "lost");
});

test("cross-room guidance discards a route if the destination or recognized room changes in flight", async (t) => {
  const data = fixture();
  let change = () => { data.session.guideDestination = { ...data.session.guideDestination, elementId: "other-item" }; };
  mockRoomtrace(t, data, { afterRoute: () => change() });
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
  change = () => { data.session.guideSpace = { ...destinationRoom }; };
  assertUnknown(await computeGuideGuidance({}, data.session, pose(), { now: () => 100 }), "unavailable");
});

test("binding a recognized room preserves the persisted destination and restores only its matching revision", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "guide-cross-room-"));
  const path = join(directory, "chat.sqlite"), agent = createAgent({ path });
  t.after(() => { agent.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = agent.create();
  // Seed only the isolated conversation fixture; room binding itself uses the exported public API.
  const fixtureDb = new DatabaseSync(path);
  try {
    fixtureDb.prepare("UPDATE conversations SET data=? WHERE id=?").run(JSON.stringify({ ...session,
      guideSpace: { ...destinationRoom }, guideTarget: { ...savedTarget } }), session.id);
  } finally { fixtureDb.close(); }
  const expectedDestination = { ...savedTarget, mapId: destinationRoom.id, revision: destinationRoom.revision };
  const recognized = agent.bindGuideRoom(session.id, { ...currentRoom });
  assert.deepEqual(recognized.guideDestination, expectedDestination, "A legacy local target becomes a persistent cross-room destination");
  assert.equal(recognized.guideTarget, undefined);
  assert.deepEqual(agent.get(session.id).guideDestination, expectedDestination);
  const stale = agent.bindGuideRoom(session.id, { ...destinationRoom, revision: destinationRoom.revision + 1 });
  assert.equal(stale.guideTarget, undefined, "Recognition must not restore a target from a different model revision");
  assert.deepEqual(stale.guideDestination, expectedDestination);
  const restored = agent.bindGuideRoom(session.id, { ...destinationRoom });
  assert.deepEqual(restored.guideTarget, savedTarget);
  assert.deepEqual(restored.guideDestination, expectedDestination);
  assert.deepEqual(agent.get(session.id).guideTarget, savedTarget);
  assert.equal(restored.guide, true);
  assert.equal(restored.readOnly, true);
  assert.deepEqual(restored.messages, [], "Room recognition does not invoke a provider or invent a spoken turn");
});

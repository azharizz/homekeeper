import test from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Vector3 } from "three";
import { createGuideTracker, freshGuideMatch, modelCameraMatrix, xrModelAlignment, xrCameraCalibration } from "../web/guide-tracking.js";

const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const scene = { revision: 4, mode: "architecture", display_from_world: identity };
const match = (captured_at = 100) => ({ status: "localized", map_revision: 4, captured_at,
  world_to_camera: [[1, 0, 0, -2], [0, 1, 0, -3], [0, 0, 1, -4]], inliers: 20 });
const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-7, `${actual} != ${expected}`));
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

// Deterministic mathematical checks, not a claim of physical pose accuracy.
test("camera conversion, XR movement/orientation alignment, and fresh evidence", () => {
  const camera = modelCameraMatrix(match(), scene);
  close(new Vector3().setFromMatrixPosition(camera).toArray(), [2, 3, 4]);
  close(new Vector3(0, 0, -1).transformDirection(camera).toArray(), [0, 0, 1]);
  const display = new Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 0, 0);
  const transformed = modelCameraMatrix(match(), { ...scene, display_from_world: [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => display.elements[c * 4 + r])) });
  close(new Vector3().setFromMatrixPosition(transformed).toArray(), [14, 3, -2]);
  close(new Vector3(0, 0, -1).transformDirection(transformed).toArray(), [1, 0, 0]);

  const initialXR = new Matrix4().makeTranslation(5, 0, 0);
  const alignment = xrModelAlignment(camera, initialXR, scene);
  close(alignment.clone().multiply(initialXR).elements, camera.elements);
  const moved = new Matrix4().makeRotationY(Math.PI / 2).setPosition(6, 0, 0);
  const modelMoved = alignment.clone().multiply(moved);
  close(new Vector3().setFromMatrixPosition(modelMoved).toArray(), [3, 3, 4]);
  close(new Vector3(0, 0, -1).transformDirection(modelMoved).toArray(), [-1, 0, 0]);
  const scaled = xrModelAlignment(camera, initialXR, { ...scene, mode: "multiview", scale: { meters_per_unit: 0.5 } });
  close(new Vector3().setFromMatrixPosition(scaled.multiply(new Matrix4().makeTranslation(6, 0, 0))).toArray(), [4, 3, 4]);
  assert.equal(xrModelAlignment(camera, initialXR, { ...scene, mode: "multiview", scale: null }), null);
  assert.equal(modelCameraMatrix({ ...match(), world_to_camera: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }, scene), null);
  assert.equal(freshGuideMatch(match(), 4, 4, 104), true);
  for (const [result, revision, currentRevision, now] of [
    [match(), 4, 4, 106], [match(), 4, 5, 100], [match(), 5, 5, 100],
    [match(101), 4, 4, 100], [{ ...match(), status: "lost" }, 4, 4, 100],
    [{ ...match(), captured_at: NaN }, 4, 4, 100],
    [{ ...match(), world_to_camera: [[NaN, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] }, 4, 4, 100],
  ]) assert.equal(freshGuideMatch(result, revision, currentRevision, now), false);
  const projection = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100).elements;
  assert.deepEqual(xrCameraCalibration(projection, 640, 480), { model: "PINHOLE", width: 640, height: 480, params: [320, 240, 320, 240] });
  assert.equal(xrCameraCalibration(projection, NaN, 480), null);
});

test("camera loop is serialized, clears failed/stale poses, discards old runs and cleans lifecycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100000 });
  const priorDocument = globalThis.document;
  const globals = ["navigator", "XRWebGLBinding", "XRWebGLLayer"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const events = new Map(), updates = [], canvases = [];
  globalThis.document = {
    hidden: false,
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => "data:image/jpeg;base64,YWJj" };
      canvases.push(canvas); return canvas;
    },
    addEventListener(type, callback) { events.set(type, callback); },
    removeEventListener(type) { events.delete(type); },
  };
  let revision = 4, posts = 0, outstanding = 0, maxOutstanding = 0, complete;
  const requests = [];
  const tracker = createGuideTracker({
    video: { videoWidth: 640, videoHeight: 480, readyState: 4 }, onUpdate: (update) => updates.push(update),
    request(path, options) {
      requests.push({ path, options });
      if (path.endsWith("/scene")) return Promise.resolve({ ...scene, revision });
      posts++; outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
      return new Promise((resolve) => {
        // Deliberately ignore abort here, so a late transport callback is exercised.
        complete = (value) => { outstanding--; resolve(value); };
      });
    },
  });
  const last = () => updates.at(-1);
  const accept = async () => {
    const captured = Number(requests.findLast((entry) => entry.path.endsWith("/localize")).options.body.get("captured_at"));
    complete(match(captured)); await flush();
  };
  try {
    tracker.start({ id: "room", revision: 4 }); await flush();
    assert.equal(posts, 1);
    t.mock.timers.tick(3000); await flush();
    assert.equal(posts, 1, "no second upload while a localization is outstanding");
    await accept(); assert.equal(last().status, "tracking");
    close(last().position, [2, 3, 4]);
    tracker.snapshot(); tracker.snapshot(); assert.equal(canvases.length, 1, "snapshot canvas is reused");
    t.mock.timers.tick(1500); await flush();
    complete({ status: "lost", map_revision: 4, reason: "No geometric match" }); await flush();
    assert.equal(last().status, "lost"); assert.equal(last().position, null); assert.equal(last().quaternion, null);
    t.mock.timers.tick(1500); await flush(); await accept(); assert.equal(last().status, "tracking");
    t.mock.timers.tick(5500); await flush();
    assert.equal(last().position, null, "a previous match never survives its freshness deadline");
    assert.equal(maxOutstanding, 1);
    const oldComplete = complete, oldRequest = requests.findLast((entry) => entry.path.endsWith("/localize"));
    tracker.stop(); await flush();
    assert.equal(oldRequest.options.signal.aborted, true);
    assert.equal(last().status, "stopped");
    const stoppedCount = updates.length, stoppedPosts = posts;
    oldComplete(match(100)); await flush();
    t.mock.timers.tick(20000); await flush();
    assert.equal(updates.length, stoppedCount, "late callbacks cannot resurrect a stopped run");
    assert.equal(posts, stoppedPosts, "stop prevents future uploads"); assert.equal(events.size, 0);

    tracker.start({ id: "new-room", revision: 4 }); await flush();
    assert.equal(requests.at(-1).path, "/maps/new-room/localize");
    await accept(); assert.equal(last().mapId, "new-room");
    revision = 5;
    t.mock.timers.tick(1500); await flush();
    assert.equal(last().status, "stopped"); assert.match(last().reason, /revision changed/);
    assert.equal(last().position, null);

    revision = 4;
    tracker.start({ id: "room", revision: 4 }); await flush();
    globalThis.document.hidden = true; events.get("visibilitychange")(); await flush();
    assert.equal(last().status, "stopped"); assert.equal(last().position, null);
    assert.equal(requests.at(-1).options.signal.aborted, true);
    complete(match()); await flush();

    // A delayed requestSession resolves after stop: end it without installing an
    // XR frame loop or accepting camera callbacks from the earlier run.
    globalThis.document.hidden = false;
    let openSession, ended = 0;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { xr: {
      requestSession: () => new Promise((resolve) => { openSession = resolve; }),
    } } });
    globalThis.XRWebGLBinding = function () {};
    globalThis.XRWebGLLayer = function () {};
    tracker.start({ id: "room", revision: 4 }); await flush();
    const opening = tracker.startXR();
    assert.equal(last().source, "webxr"); assert.equal(last().position, null);
    tracker.stop();
    openSession({ end: async () => { ended++; } });
    await opening; await flush();
    assert.equal(ended, 1); assert.equal(last().status, "stopped");
    complete(match()); await flush();
    const count = posts; t.mock.timers.tick(20000); await flush(); assert.equal(posts, count);
  } finally {
    tracker.stop(); globalThis.document = priorDocument; t.mock.timers.reset();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test("XR scheduler rematches at four seconds, invalidates alignment, and releases session resources", async (t) => {
  // Fake browser hardware exercises real tracker scheduling and lifecycle only:
  // this is not proof of camera texture availability or physical tracking accuracy.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100000 });
  const globals = ["document", "navigator", "XRWebGLBinding", "XRWebGLLayer"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const referenceEvents = new Map(), sessionEvents = new Map(), documentEvents = new Map();
  const updates = [], uploads = [], deleted = [];
  let nextFrame, frameId = 0, cancelled = 0, ended = 0, lostContext = 0, complete;
  const gl = { FRAMEBUFFER_COMPLETE: 1, NO_ERROR: 0,
    makeXRCompatible: async () => {}, getShaderParameter: () => true, getProgramParameter: () => true,
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    checkFramebufferStatus: () => 1, getError: () => 0,
    getExtension: () => ({ loseContext: () => { lostContext++; } }),
    readPixels: (_x, _y, _w, _h, _format, _type, pixels) => pixels.fill(255),
  };
  for (const kind of ["Program", "Shader", "Buffer", "Texture", "Framebuffer"]) {
    gl[`create${kind}`] = () => ({ kind });
    gl[`delete${kind}`] = (resource) => deleted.push(resource.kind);
  }
  for (const name of ["shaderSource", "compileShader", "attachShader", "linkProgram", "bindBuffer", "bufferData",
    "bindTexture", "texParameteri", "texImage2D", "bindFramebuffer", "framebufferTexture2D", "viewport",
    "disable", "useProgram", "enableVertexAttribArray", "vertexAttribPointer", "activeTexture", "uniform1i",
    "drawArrays", "clearColor", "clear"]) gl[name] = () => {};
  const reference = {
    addEventListener: (type, callback) => referenceEvents.set(type, callback),
    removeEventListener: (type) => referenceEvents.delete(type),
  };
  const session = {
    domOverlayState: { type: "screen" },
    requestReferenceSpace: async () => reference,
    updateRenderState() {},
    addEventListener: (type, callback) => sessionEvents.set(type, callback),
    removeEventListener: (type) => sessionEvents.delete(type),
    requestAnimationFrame(callback) { nextFrame = callback; return ++frameId; },
    cancelAnimationFrame() { cancelled++; nextFrame = null; },
    end: async () => { ended++; },
  };
  const context = {
    drawImage() {}, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    hidden: false, body: {},
    createElement: () => ({ width: 0, height: 0, getContext: (type) => type === "webgl" ? gl : context,
      toDataURL: () => "data:image/jpeg;base64,YWJj" }),
    addEventListener: (type, callback) => documentEvents.set(type, callback),
    removeEventListener: (type) => documentEvents.delete(type),
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { xr: {
    requestSession: async (mode, options) => {
      assert.equal(mode, "immersive-ar"); assert.ok(options.optionalFeatures.includes("camera-access"));
      assert.ok(options.optionalFeatures.includes("dom-overlay")); return session;
    },
  } } });
  globalThis.XRWebGLBinding = class { getCameraImage() { return { opaqueCamera: true }; } };
  globalThis.XRWebGLLayer = class { constructor() { this.framebuffer = {}; } };
  const tracker = createGuideTracker({
    video: { videoWidth: 640, videoHeight: 480, readyState: 4 }, onUpdate: (value) => updates.push(value),
    request(path, options) {
      if (path.endsWith("/scene")) return Promise.resolve(scene);
      return new Promise((resolve) => {
        uploads.push(options);
        complete = () => resolve(match(Number(options.body.get("captured_at"))));
      });
    },
  });
  const last = () => updates.at(-1);
  const projectionMatrix = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100).elements;
  const view = { camera: { width: 4, height: 4 }, projectionMatrix, transform: { matrix: new Matrix4().elements } };
  const frame = () => nextFrame(0, { getViewerPose: () => ({ emulatedPosition: false, views: [view] }) });
  try {
    tracker.start({ id: "room", revision: 4 });
    await tracker.startXR(); await flush();
    frame(); await flush(); assert.equal(uploads.length, 1);
    assert.deepEqual(JSON.parse(uploads[0].body.get("calibration")).params, [2, 2, 2, 2]);
    complete(); await flush(); frame(); assert.equal(last().status, "tracking");
    assert.equal(last().source, "webxr"); close(last().position, [2, 3, 4]);
    assert.equal(tracker.snapshot().captured_at, 100);

    t.mock.timers.tick(3999); frame(); await flush();
    assert.equal(uploads.length, 1, "no XR rematch before four seconds");
    t.mock.timers.tick(1); frame(); await flush();
    assert.equal(uploads.length, 2, "four seconds schedules a new real localize request");
    complete(); await flush(); frame(); assert.equal(last().status, "tracking");

    // Advance only the clock, preserving a frame callback so expiry is tested
    // in the frame path independently of watchdog frame-gap detection.
    t.mock.timers.setTime(117000); frame();
    assert.equal(last().position, null); assert.match(last().reason, /alignment expired/i);
    await flush();
    const expiredUpload = uploads.at(-1);
    referenceEvents.get("reset")();
    assert.equal(last().position, null); assert.match(last().reason, /reference reset/i);
    assert.equal(expiredUpload.signal.aborted, true);
    complete(); await flush(); // late match from pre-reset reference is discarded
    assert.equal(last().position, null);

    frame(); await flush(); complete(); await flush(); frame();
    assert.equal(last().status, "tracking");
    const staleFrame = nextFrame;
    tracker.stop(); await flush();
    assert.equal(last().status, "stopped"); assert.equal(last().position, null);
    assert.equal(ended, 1); assert.equal(cancelled, 1); assert.equal(lostContext, 1);
    assert.equal(referenceEvents.size, 0); assert.equal(sessionEvents.size, 0); assert.equal(documentEvents.size, 0);
    assert.deepEqual(deleted.sort(), ["Buffer", "Framebuffer", "Program", "Shader", "Shader", "Texture"].sort());
    const count = uploads.length, updateCount = updates.length;
    staleFrame(0, { getViewerPose: () => { throw new Error("Stopped frame must not access hardware"); } });
    t.mock.timers.tick(20000); await flush();
    assert.equal(uploads.length, count); assert.equal(updates.length, updateCount);
  } finally {
    tracker.stop(); t.mock.timers.reset();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

import { Matrix4, Quaternion, Vector3 } from "three";

export const GUIDE_POSE_MAX_AGE = 5; // seconds, including localization latency
const REQUEST_TIMEOUT = 8000;
const CAMERA_GAP = 1500;
const ALIGNMENT_MAX_AGE = 12;
const XR_MATCH_GAP = 4; // seconds, same clock as captured_at
const CAMERA_MODE = "Camera localization only: lower-rate map matches, no inertial prediction.";

const finiteRows = (value, rows, columns) => Array.isArray(value) && value.length === rows &&
  value.every((row) => Array.isArray(row) && row.length === columns && row.every(Number.isFinite));
const nowSeconds = () => Date.now() / 1000;

export function freshGuideMatch(result, revision, currentRevision, now = nowSeconds()) {
  return result?.status === "localized" && result.map_revision === revision && currentRevision === revision &&
    Number.isFinite(result.captured_at) && result.captured_at <= now && now - result.captured_at <= GUIDE_POSE_MAX_AGE &&
    finiteRows(result.world_to_camera, 3, 4);
}

// COLMAP uses +Y down/+Z forward; a Three/XR camera uses +Y up/-Z forward.
export function modelCameraMatrix(result, scene) {
  if (!finiteRows(result?.world_to_camera, 3, 4) ||
      (scene.display_from_world != null && !finiteRows(scene.display_from_world, 4, 4))) return null;
  const extrinsic = new Matrix4().set(...result.world_to_camera.flat(), 0, 0, 0, 1);
  if (Math.abs(extrinsic.determinant()) < 1e-8) return null;
  const pose = extrinsic.invert();
  if (scene.display_from_world) pose.premultiply(new Matrix4().set(...scene.display_from_world.flat()));
  pose.multiply(new Matrix4().makeScale(1, -1, -1));
  return pose.elements.every(Number.isFinite) ? pose : null;
}

// XR metres must not be mistaken for unscaled reconstruction units.
export function xrModelAlignment(modelCamera, xrCamera, scene) {
  const metersPerUnit = scene.mode === "architecture" ? 1 : scene.scale?.meters_per_unit;
  if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0 || Math.abs(xrCamera.determinant()) < 1e-8) return null;
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  modelCamera.decompose(position, rotation, scale);
  const displayScale = scene.display_from_world
    ? new Vector3().setFromMatrixScale(new Matrix4().set(...scene.display_from_world.flat()))
    : new Vector3(1, 1, 1);
  if (Math.max(...displayScale.toArray()) - Math.min(...displayScale.toArray()) > 1e-5) return null;
  const unitsPerMeter = displayScale.x / metersPerUnit;
  return new Matrix4().compose(position, rotation, new Vector3(unitsPerMeter, unitsPerMeter, unitsPerMeter))
    .multiply(xrCamera.clone().invert());
}

export function xrCameraCalibration(projection, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      !projection || projection.length !== 16 || !Array.from(projection).every(Number.isFinite) ||
      Math.abs(projection[11] + 1) > 1e-5 || Math.abs(projection[15]) > 1e-5) return null;
  const params = [projection[0] * width / 2, projection[5] * height / 2,
    (1 - projection[8]) * width / 2, (1 + projection[9]) * height / 2];
  if (params[0] <= 0 || params[1] <= 0) return null;
  return { model: "PINHOLE", width, height, params };
}

function jpegBlob(dataUrl) {
  const bytes = atob(dataUrl.split(",")[1]), buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: "image/jpeg" });
}

// Sample the opaque XR camera texture inside its active frame. Render to our own
// framebuffer instead of attaching a runtime-owned texture or assuming readback support.
function cameraReader(gl) {
  const program = gl.createProgram(), shaders = [];
  for (const [type, source] of [
    [gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 uv; void main(){uv=(p+1.0)*0.5;gl_Position=vec4(p,0.,1.);}"],
    [gl.FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; uniform sampler2D camera; void main(){gl_FragColor=texture2D(camera,uv);}"],
  ]) {
    const shader = gl.createShader(type); shaders.push(shader);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("XR camera shader is unsupported.");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("XR camera readback is unsupported.");
  const buffer = gl.createBuffer(), texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, "p");
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
  let pixels, image;
  return {
    capture(cameraTexture, width, height) {
      const factor = Math.min(1, 1024 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
      if (canvas.width !== w || canvas.height !== h || !pixels) {
        canvas.width = w; canvas.height = h; pixels = new Uint8Array(w * h * 4); image = context.createImageData(w, h);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("XR camera framebuffer is unavailable.");
      gl.viewport(0, 0, w, h); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
      gl.uniform1i(gl.getUniformLocation(program, "camera"), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Browser does not allow XR camera readback.");
      for (let y = 0; y < h; y++) image.data.set(pixels.subarray(y * w * 4, (y + 1) * w * 4), (h - y - 1) * w * 4);
      context.putImageData(image, 0, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return canvas.toDataURL("image/jpeg", 0.8);
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture); gl.deleteBuffer(buffer);
      gl.deleteProgram(program); shaders.forEach((shader) => gl.deleteShader(shader));
    },
  };
}

export function createGuideTracker({ video, onUpdate, request }) {
  const canvas = document.createElement("canvas");
  let generation = 0, selected = null, timer = null, watchdog = null, pending = null, busy = false;
  let xr = null, xrStarting = false, alignment = null, alignedAt = 0, lastXRMatch = 0, lastXRFrame = 0;
  let xrEpoch = 0, xrImage = null, openingSession = null;
  let state = { status: "stopped", source: "camera", mapId: null, revision: null,
    capturedAt: null, position: null, quaternion: null, reason: "Tracking stopped.", inliers: null,
    reprojectionErrorPx: null, latencyMs: null };
  const current = (run) => generation === run && selected != null && !document.hidden;
  function publish(status, reason, values = {}) {
    state = { ...state, status, reason, position: null, quaternion: null, capturedAt: null,
      inliers: null, reprojectionErrorPx: null, latencyMs: null,
      mapId: selected?.id ?? null, revision: selected?.revision ?? null, source: xr ? "webxr" : "camera", ...values };
    onUpdate({ ...state });
  }
  function poseUpdate(matrix, capturedAt, result, source) {
    const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
    matrix.decompose(position, rotation, scale);
    const xrReason = "Map-aligned WebXR estimate; physical accuracy and obstacles are unverified." +
      (xr?.session.domOverlayState ? "" : " DOM overlay unavailable; debug view is visible after exiting AR.");
    publish("tracking", source === "camera" ? CAMERA_MODE : xrReason, {
      position: position.toArray(), quaternion: rotation.toArray(), capturedAt, source,
      inliers: result?.inliers ?? state.inliers, reprojectionErrorPx: result?.reprojection_error_px ?? state.reprojectionErrorPx,
      latencyMs: result?.latency_ms ?? state.latencyMs,
    });
  }
  function snapshot() {
    if (xr) {
      if (!xrImage || nowSeconds() - xrImage.captured_at > GUIDE_POSE_MAX_AGE || nowSeconds() - lastXRFrame > 1) {
        throw new Error("A fresh XR camera image is not available yet.");
      }
      return { ...xrImage };
    }
    if (!video?.videoWidth || !video?.videoHeight || video.readyState < 2) throw new Error("Camera is not ready. Open the camera first.");
    const factor = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * factor), height = Math.round(video.videoHeight * factor);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    canvas.getContext("2d").drawImage(video, 0, 0, width, height);
    const data_url = canvas.toDataURL("image/jpeg", 0.8);
    if (data_url.length > 1400000) throw new Error("Camera image is too large. Please try again.");
    return { data_url, captured_at: nowSeconds() };
  }
  async function call(path, options, run) {
    if (!current(run)) throw new Error("Tracking run ended.");
    const controller = new AbortController(); pending = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () =>
      reject(new Error("Localization timed out or tracking stopped.")), { once: true }));
    try { return await Promise.race([request(path, { ...options, signal: controller.signal }), aborted]); }
    finally { clearTimeout(timeout); if (pending === controller) pending = null; }
  }
  function schedule(run) {
    if (current(run) && !xr && !xrStarting) timer = setTimeout(() => { timer = null; void cameraTick(run); }, CAMERA_GAP);
  }
  async function localize(run, image, xrPose = null, calibration = null) {
    if (busy || !current(run)) return;
    busy = true;
    const activeXR = xr, epoch = xrEpoch;
    const valid = () => current(run) && (xrPose ? xr === activeXR && epoch === xrEpoch : !xr && !xrStarting);
    try {
      const map = selected, prefix = `/maps/${encodeURIComponent(map.id)}`;
      if (xrPose) {
        const before = await call(`${prefix}/scene`, undefined, run);
        if (!valid()) return;
        if (before.revision !== map.revision) { stop("The saved room revision changed. Select the current room again."); return; }
      }
      const form = new FormData(); form.append("image", image.blob, "guide-view.jpg");
      form.append("captured_at", String(image.captured_at));
      if (calibration) form.append("calibration", JSON.stringify(calibration));
      const result = await call(`${prefix}/localize`, { method: "POST", body: form }, run);
      if (!valid()) return;
      const scene = await call(`${prefix}/scene`, undefined, run);
      if (!valid()) return;
      if (scene.revision !== map.revision || result.map_revision !== map.revision) {
        stop("The saved room revision changed. Select the current room again."); return;
      }
      if (!freshGuideMatch(result, map.revision, scene.revision) || result.captured_at !== image.captured_at) {
        alignment = null; publish("lost", result.reason || "No fresh geometric match. Position unknown."); return;
      }
      const matrix = modelCameraMatrix(result, scene);
      if (!matrix) { alignment = null; publish("lost", "Invalid camera pose. Position unknown."); return; }
      if (xrPose) {
        const next = xrModelAlignment(matrix, xrPose, scene);
        if (!next) { endXR("XR alignment needs a metric map scale. " + CAMERA_MODE); return; }
        if (alignment) {
          const predicted = new Matrix4().multiplyMatrices(alignment, xrPose);
          const unitsPerMeter = new Vector3().setFromMatrixScale(alignment).x;
          const distance = new Vector3().setFromMatrixPosition(predicted).distanceTo(new Vector3().setFromMatrixPosition(matrix)) / unitsPerMeter;
          const angle = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(predicted))
            .angleTo(new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(matrix)));
          if (distance > 0.75 || angle > Math.PI / 6) {
            alignment = null;
            publish("aligning", "XR alignment drift detected. Reacquired alignment from the new verified map-camera match.");
          }
        }
        // A new verified map match replaces alignment; never extrapolate across a reset or drift.
        alignment = next; alignedAt = image.captured_at;
        if (!lastXRFrame || nowSeconds() - lastXRFrame > 1) publish("lost", "XR pose unavailable. Position unknown.");
      } else poseUpdate(matrix, result.captured_at, result, "camera");
    } catch (error) {
      if (valid()) { alignment = null; publish("lost", `${error.message} Position unknown.`); }
    } finally {
      busy = false;
      if (current(generation) && !xr && !timer) schedule(generation);
    }
  }
  async function cameraTick(run) {
    if (!current(run) || xr || xrStarting || busy) { if (current(run) && !xr) schedule(run); return; }
    try {
      // Check before upload as well as after: a room edit must not drive the old model.
      busy = true;
      const scene = await call(`/maps/${encodeURIComponent(selected.id)}/scene`, undefined, run);
      if (!current(run) || xr || xrStarting) return;
      if (scene.revision !== selected.revision) { stop("The saved room revision changed. Select the current room again."); return; }
      const image = snapshot(); busy = false;
      await localize(run, { blob: jpegBlob(image.data_url), captured_at: image.captured_at });
    } catch (error) {
      if (current(run) && !xr && !xrStarting) publish("lost", `${error.message} ${CAMERA_MODE}`);
    } finally {
      busy = false;
      if (current(generation) && !xr && !timer) schedule(generation);
    }
  }
  function releaseXR(session) {
    session.reference.removeEventListener("reset", session.reset);
    session.session.removeEventListener("end", session.ended);
    session.session.cancelAnimationFrame(session.frame);
    session.reader?.dispose(); session.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  function endXR(reason) {
    const old = xr; xr = null; xrEpoch++; xrImage = null; alignment = null; alignedAt = 0; lastXRFrame = 0;
    pending?.abort();
    if (old) { releaseXR(old); void old.session.end().catch(() => {}); }
    if (selected) { publish("aligning", reason || CAMERA_MODE); if (!timer) schedule(generation); }
  }
  function stop(reason = "Tracking stopped.") {
    generation++; selected = null; clearTimeout(timer); clearInterval(watchdog); timer = null; watchdog = null;
    pending?.abort(); endXR();
    if (openingSession) {
      openingSession.gl?.getExtension("WEBGL_lose_context")?.loseContext();
      void openingSession.session.end().catch(() => {});
      openingSession = null;
    }
    document.removeEventListener("visibilitychange", visibility);
    publish("stopped", reason);
  }
  function visibility() { if (document.hidden) stop("Tracking stopped while the page is in the background. Restart to match the room again."); }
  function start(map) {
    stop();
    if (!map?.id || map.revision == null) { publish("stopped", "Select a saved room revision first."); return; }
    selected = { id: map.id, revision: map.revision };
    document.addEventListener("visibilitychange", visibility);
    publish("aligning", CAMERA_MODE);
    const run = generation;
    watchdog = setInterval(() => {
      const now = nowSeconds();
      if (xr && alignment && (now - alignedAt > ALIGNMENT_MAX_AGE || now - lastXRFrame > 1)) {
        alignment = null; publish("aligning", "XR map alignment expired or frame tracking was lost. Reacquiring a camera match.");
      } else if (state.position && now - state.capturedAt > GUIDE_POSE_MAX_AGE) publish("lost", "Camera pose expired. Position unknown. " + CAMERA_MODE);
    }, 250);
    if (!busy) void cameraTick(run); else schedule(run);
  }
  // Call directly from a click/tap; requestSession runs before any await, preserving user activation.
  async function startXR() {
    if (!selected || document.hidden || xr || xrStarting) return;
    if (!globalThis.navigator?.xr || !globalThis.XRWebGLBinding || !globalThis.XRWebGLLayer) {
      publish(state.position ? "tracking" : "aligning", "WebXR raw camera access is unsupported. " + CAMERA_MODE,
        state.position ? { position: state.position, quaternion: state.quaternion, capturedAt: state.capturedAt } : {});
      return;
    }
    const run = generation; xrStarting = true;
    clearTimeout(timer); timer = null; pending?.abort();
    publish("aligning", "Starting WebXR; position unknown until a raw camera frame matches the map.", { source: "webxr" });
    let session, gl, reader;
    try {
      const overlayRoot = document.querySelector?.(".voice-guide") || document.body;
      session = await navigator.xr.requestSession("immersive-ar", {
        optionalFeatures: ["camera-access", ...(overlayRoot ? ["dom-overlay"] : [])], requiredFeatures: ["local"],
        ...(overlayRoot ? { domOverlay: { root: overlayRoot } } : {}),
      });
      if (!current(run)) { await session.end(); return; }
      openingSession = { session, gl: null };
      clearTimeout(timer); timer = null; pending?.abort();
      const surface = document.createElement("canvas");
      gl = surface.getContext("webgl", { xrCompatible: true, alpha: true });
      if (!gl) throw new Error("XR WebGL is unavailable.");
      openingSession.gl = gl;
      await gl.makeXRCompatible();
      if (!current(run)) { await session.end().catch(() => {}); return; }
      const reference = await session.requestReferenceSpace("local");
      if (!current(run)) { await session.end(); gl.getExtension("WEBGL_lose_context")?.loseContext(); return; }
      const binding = new XRWebGLBinding(session, gl);
      if (typeof binding.getCameraImage !== "function") throw new Error("XR raw camera API is unavailable.");
      const layer = new XRWebGLLayer(session, gl);
      session.updateRenderState({ baseLayer: layer });
      reader = cameraReader(gl);
      const reset = () => {
        xrEpoch++; xrImage = null; alignment = null; alignedAt = 0; lastXRMatch = 0; pending?.abort();
        publish("aligning", "XR reference reset. Reacquiring map alignment; position unknown.");
      };
      const ended = () => endXR("XR ended. " + CAMERA_MODE);
      xr = { session, gl, reference, reader, reset, ended, frame: null };
      openingSession = null;
      reference.addEventListener("reset", reset); session.addEventListener("end", ended);
      alignment = null; alignedAt = 0; lastXRMatch = 0;
      publish("aligning", "Acquiring a real XR camera match to the saved room; position unknown.");
      const active = xr, cameraMatrix = new Matrix4(), modelMatrix = new Matrix4();
      function frame(_time, xrFrame) {
        if (!current(run) || xr !== active) return;
        active.frame = session.requestAnimationFrame(frame);
        // Our texture-copy target never aliases the immersive layer. Keep that
        // layer transparent; the optional DOM overlay owns the model/debug UI.
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const pose = xrFrame.getViewerPose(reference);
        if (!pose) {
          xrEpoch++; alignment = null; xrImage = null; lastXRFrame = 0; pending?.abort();
          if (state.status !== "lost") publish("lost", "XR visual-inertial tracking lost. Position unknown.");
          return;
        }
        const view = pose?.views.find((item) => item.camera);
        if (!view || pose.emulatedPosition) {
          endXR("XR raw camera or measured position is unavailable. " + CAMERA_MODE); return;
        }
        const now = nowSeconds(); lastXRFrame = now;
        if (view.transform.matrix.length !== 16 || !Array.from(view.transform.matrix).every(Number.isFinite)) {
          endXR("XR supplied an invalid camera pose. " + CAMERA_MODE); return;
        }
        cameraMatrix.fromArray(view.transform.matrix);
        if (alignment && now - alignedAt <= ALIGNMENT_MAX_AGE) {
          modelMatrix.multiplyMatrices(alignment, cameraMatrix); poseUpdate(modelMatrix, now, null, "webxr");
        } else if (alignment) { alignment = null; publish("aligning", "XR alignment expired. Reacquiring a map match."); }
        const shouldMatch = !busy && now - lastXRMatch >= XR_MATCH_GAP;
        if (!shouldMatch && xrImage && now - xrImage.captured_at < 1) return;
        try {
          const camera = view.camera, calibration = xrCameraCalibration(view.projectionMatrix, camera.width, camera.height);
          const texture = binding.getCameraImage(camera);
          if (!texture || !calibration) throw new Error("XR raw camera calibration is unavailable.");
          const data_url = reader.capture(texture, camera.width, camera.height);
          xrImage = { data_url, captured_at: now };
          if (!shouldMatch) return;
          lastXRMatch = now;
          void localize(run, { blob: jpegBlob(data_url), captured_at: now }, cameraMatrix.clone(), calibration);
        } catch (error) { endXR(`${error.message} ${CAMERA_MODE}`); }
      }
      active.frame = session.requestAnimationFrame(frame);
    } catch (error) {
      if (session) { reader?.dispose(); await session.end().catch(() => {}); }
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      if (current(run)) { publish("aligning", `WebXR unavailable: ${error.message} ${CAMERA_MODE}`); if (!timer) schedule(run); }
    } finally {
      if (openingSession?.session === session) openingSession = null;
      xrStarting = false;
      if (current(generation) && !xr && !timer) schedule(generation);
    }
  }
  return { start, stop, startXR, snapshot };
}

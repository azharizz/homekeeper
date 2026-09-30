// Isolated camera-lifetime checks with explicit hardware doubles, not a live-device test.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const built = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  build: {
    lib: {
      entry: fileURLToPath(
        new URL("../../../web/spaces/Camera.jsx", import.meta.url),
      ),
      formats: ["es"],
      fileName: "camera",
    },
    write: false,
    minify: false,
  },
});
const { default: Camera } = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      built[0].output.find((item) => item.type === "chunk").code,
    ).toString("base64")
);
let stops = 0,
  captures = 0,
  encoded;
const video = { videoWidth: 640, videoHeight: 480, play: async () => {} };
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => stops++ }],
      }),
    },
  },
});
globalThis.document = {
  createElement: () => ({
    getContext: () => ({ drawImage() {} }),
    toBlob: (resolve) => {
      encoded = resolve;
    },
  }),
};
const camera = new Camera({
  continuous: false,
  onStop() {},
  onFrame: async (_, timestamp, current, started) => {
    assert(timestamp > 0 && performance.now() >= started && current());
    captures++;
  },
});
camera.video.current = video;
camera.setState = (patch) => {
  camera.state = { ...camera.state, ...patch };
};
await camera.start();
assert(
  camera.state.active && captures === 0,
  "Opening a draft preview must not upload automatically",
);
const first = camera.snapshot();
assert(camera.state.busy);
encoded(new Blob(["isolated test"]));
await first;
assert.equal(captures, 1);
assert(!camera.state.busy);
const pending = camera.snapshot();
camera.stop();
encoded(new Blob(["cancelled test"]));
await pending;
assert.equal(captures, 1, "Stopped camera must not submit a late frame");
assert.equal(stops, 1);
assert(!camera.state.active && !camera.state.busy);
await camera.start();
camera.componentWillUnmount();
assert.equal(
  stops,
  2,
  "Leaving the native feature stops its active camera track",
);
console.log(
  "PASS: manual preview, explicit capture, busy state and cancelled encoding without late uploads",
);

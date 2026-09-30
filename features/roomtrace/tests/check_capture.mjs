// Capture intake contract shared by HomeKeeper Spaces.
import assert from "node:assert/strict";
import { captureProblem, mergeFiles } from "../../../web/spaces/capture.js";

const photos = Array.from({ length: 13 }, (_, i) => ({
  name: `${i}.jpg`,
  size: 1024,
  lastModified: i,
}));
const video = { name: "tour.MP4", size: 1024, lastModified: 1 };
assert.equal(captureProblem([], {}), "");
for (const count of [1, 3, 13])
  assert.match(captureProblem(photos.slice(0, count)), /4 to 12/);
for (const count of [4, 9, 12])
  assert.equal(captureProblem(photos.slice(0, count)), "");
assert.equal(captureProblem([video]), "");
assert.match(captureProblem([video, photos[0]]), /one video/);
assert.match(
  captureProblem([video, { ...video, name: "other.mov" }]),
  /one video/,
);
assert.match(captureProblem([{ ...photos[0], name: "document.pdf" }]), /JPEG/);
assert.match(
  captureProblem(photos.slice(0, 4), { max_upload_mb: 0.001 }),
  /upload limit/,
);
assert.equal(
  captureProblem(photos.slice(0, 4), { max_upload_mb: 4 / 1024 }),
  "",
);
assert.deepEqual(
  mergeFiles([photos[0]], [photos[0], photos[1], photos[1]]),
  photos.slice(0, 2),
);
assert.equal(mergeFiles([photos[0]], [{ ...photos[0], size: 2 }]).length, 2);
console.log("Capture selection contract passed.");

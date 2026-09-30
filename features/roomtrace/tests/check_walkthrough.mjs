import assert from "node:assert/strict";
import {
  pathPosition,
  stepProgress,
  insideWalkingArea,
  isClickGesture,
} from "../web/src/walkthrough-math.js";

const path = [
  [0, 0, 0],
  [0, 0, 3],
  [4, 0, 3],
];
assert.deepEqual(pathPosition(path, 2), [0, 0, 2]);
assert.deepEqual(pathPosition(path, 5), [2, 0, 3]);
assert.deepEqual(pathPosition(path, 99), [4, 0, 3]);
assert.deepEqual(pathPosition(path, -2), [0, 0, 0]);
assert.deepEqual(stepProgress(0, 7, 0.65), {
  steps: 11,
  completed: 0,
  next: 0.65,
});
assert.deepEqual(stepProgress(6.5, 7, 0.65), {
  steps: 11,
  completed: 10,
  next: 7,
});
assert.deepEqual(stepProgress(7, 7, 0.65), {
  steps: 11,
  completed: 11,
  next: 7,
});
assert.equal(stepProgress(0, 7, 0.5).steps, 14);
assert.equal(stepProgress(0, 0, 0.5).steps, 0);
assert.deepEqual(
  pathPosition(
    [
      [1, 0, 2],
      [1, 0, 2],
    ],
    0,
  ),
  [1, 0, 2],
);
console.log(
  "PASS: arc-length playback, path corners, step conversion, adjustable stride and final partial step",
);

const area = [
  {
    outer: [
      [0, 0],
      [6, 0],
      [6, 6],
      [0, 6],
      [0, 0],
    ],
    holes: [
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
        [2, 2],
      ],
    ],
  },
];
assert(insideWalkingArea([5.5, 3], area));
assert(!insideWalkingArea([3, 3], area));
assert(!insideWalkingArea([7, 3], area));
assert(isClickGesture(1));
assert(
  !isClickGesture(40),
  "Orbit drags must not select a start or destination",
);

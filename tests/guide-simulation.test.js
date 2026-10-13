import test from 'node:test';
import assert from 'node:assert/strict';
import { simulationFrame, SIMULATION_SPACE } from '../web/guide-simulation.js';
test('authored simulation is bounded, continuous and isolated from other maps and revisions', () => {
  const scene = { id: SIMULATION_SPACE, revision: 1 };
  assert.equal(simulationFrame({ ...scene, revision: 2 }, 8), null);
  assert.equal(simulationFrame({ ...scene, id: 'other' }, 8), null);
  assert.equal(simulationFrame(scene, NaN), null);
  assert.deepEqual(simulationFrame(scene, -1), simulationFrame(scene, 0));
  assert.deepEqual(simulationFrame(scene, 100), simulationFrame(scene, 16));
  const before = simulationFrame(scene, 7.999), after = simulationFrame(scene, 8.001);
  assert.ok(Math.hypot(...before.position.map((v,i) => v-after.position[i])) < .001);
  assert.ok(Math.abs(Math.hypot(...after.quaternion)-1) < 1e-12);
  assert.equal(simulationFrame(scene, 16).progress, 1);
});

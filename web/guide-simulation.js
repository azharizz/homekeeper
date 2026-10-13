import { Euler, Quaternion } from "three";

export const SIMULATION_SPACE = "710631bacf4547c69b02c08f1a6a8b55";
export const SIMULATION_CUES = ["Two steps forward.", "Be careful. Three steps forward, there is a table.", "Table ahead. Stop here."];
// Authored demonstration coordinates, not inferred camera poses or measured steps.
const keys = [
  [0, [2.9, 1.65, 2.55], -1.58, -0.12, 0.08],
  [4, [3.55, 1.65, 2.75], -1.53, -0.20, 0.16],
  [8, [4.15, 1.65, 2.95], -1.48, -0.30, 0.18],
  [12, [4.65, 1.65, 3.05], -1.43, -0.40, 0.16],
  [16, [5.0, 1.65, 3.15], -1.35, -0.60, 0.08],
];
export function simulationFrame(scene, seconds) {
  if (scene?.id !== SIMULATION_SPACE || scene.revision !== 1 || !Number.isFinite(seconds)) return null;
  const time = Math.max(0, Math.min(16, seconds));
  const i = Math.min(keys.length - 2, Math.floor(time / 4)), a = keys[i], b = keys[i + 1], t = (time - a[0]) / (b[0] - a[0]);
  const position = a[1].map((v, axis) => v + (b[1][axis] - v) * t);
  const angle = index => a[index] + (b[index] - a[index]) * t;
  const quaternion = new Quaternion().setFromEuler(new Euler(angle(3), angle(2), angle(4), "YXZ")).toArray();
  return { position, quaternion, fov: 95, time, progress: time / 16, points: keys.map(k => k[1]), target: [6.24, 0.43, 2.33] };
}

import { GUIDE_POSE_MAX_AGE } from "./guide-tracking.js";

export function currentGuidePose(tracking, scene, now, hidden = false) {
  if (hidden || !scene || tracking?.status !== "tracking" ||
      !["camera", "webxr"].includes(tracking.source) ||
      tracking.mapId !== scene.id || tracking.revision !== scene.revision ||
      !Number.isFinite(tracking.capturedAt) || !Number.isFinite(now) ||
      tracking.capturedAt > now || now - tracking.capturedAt > GUIDE_POSE_MAX_AGE ||
      !Array.isArray(tracking.position) || tracking.position.length !== 3 ||
      !tracking.position.every(Number.isFinite) ||
      !Array.isArray(tracking.quaternion) || tracking.quaternion.length !== 4 ||
      !tracking.quaternion.every(Number.isFinite) ||
      Math.abs(Math.hypot(...tracking.quaternion) - 1) > 0.02) return null;
  return tracking;
}

export function currentGuideRoute(route, scene, target) {
  if (!route || !scene || !target || route.revision !== scene.revision ||
      (route.map_id !== undefined && route.map_id !== scene.id) ||
      route.target_id !== target.elementId || route.floor_id !== target.floorId ||
      !Number.isFinite(route.distance_m) || route.distance_m < 0 ||
      !Array.isArray(route.points) || !route.points.length ||
      !route.points.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)) ||
      !Array.isArray(route.target_position) || route.target_position.length !== 3 ||
      !route.target_position.every(Number.isFinite)) return null;
  return route;
}

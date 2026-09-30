import { Matrix4, Vector3 } from "three";

export const anchorReference = (point) => ({
  element_id: point.element_id,
  ...(point.feature ? { feature: point.feature } : { anchor: point.anchor }),
});

export function anchorWorld(scene, point) {
  if (point.feature) {
    if (point.world) return point.world;
    const feature = scene.features?.[point.element_id]?.features.find(
      (f) => f.id === point.feature.id,
    );
    if (!feature)
      throw new Error("Feature is no longer available. Select it again.");
    return feature.origin.map(
      (n, i) =>
        n +
        point.feature.uv[0] * feature.u[i] +
        point.feature.uv[1] * feature.v[i],
    );
  }
  return new Vector3(...point.anchor)
    .applyMatrix4(
      new Matrix4().set(
        ...scene.components[point.element_id].anchor_matrix.flat(),
      ),
    )
    .toArray();
}

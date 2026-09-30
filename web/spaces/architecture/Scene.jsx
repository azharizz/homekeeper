import { useThree } from "@react-three/fiber";
import {
  OrbitControls,
  PerspectiveCamera,
  useGLTF,
} from "@react-three/drei";
import { DoubleSide, Plane, Vector3, Matrix4 } from "three";
import { artifact } from "../api";
import { isClickGesture } from "../walkthrough-math";

export const revisionURL = (scene, name) =>
  `${artifact(scene.id, name)}?revision=${scene.artifact_revision}`;

export function FittedCamera({ bounds, direction, span, picking }) {
  const { size } = useThree();
  const [lo, hi] = bounds;
  const target = lo.map((value, axis) => (value + hi[axis]) / 2);
  const forward = new Vector3(...direction).normalize();
  const right = new Vector3(0, 1, 0).cross(forward).normalize();
  const up = forward.clone().cross(right).normalize();
  const tanY = Math.tan((42 * Math.PI) / 360);
  const tanX = (tanY * size.width) / Math.max(size.height, 1);
  let distance = 0.5;
  for (const x of [lo[0], hi[0]])
    for (const y of [lo[1], hi[1]])
      for (const z of [lo[2], hi[2]]) {
        const offset = new Vector3(x - target[0], y - target[1], z - target[2]);
        distance = Math.max(
          distance,
          offset.dot(forward) +
            Math.max(
              Math.abs(offset.dot(right)) / tanX,
              Math.abs(offset.dot(up)) / tanY,
            ),
        );
      }
  const position = forward
    .multiplyScalar(distance * 1.1)
    .add(new Vector3(...target))
    .toArray();
  return (
    <group key={`${size.width}:${size.height}`}>
      <PerspectiveCamera
        makeDefault
        position={position}
        fov={42}
        near={0.01}
        far={span * 100}
      />
      <OrbitControls target={target} makeDefault enableRotate={!picking} />
    </group>
  );
}

export function ArchitectureMesh({
  scene,
  level,
  cutaway,
  selected,
  onSelect,
  onPick,
}) {
  const gltf = useGLTF(revisionURL(scene, "surface.glb"));
  const document = scene.architecture;
  const elements = new Map(document.elements.map((item) => [item.id, item]));
  const levels = new Map(
    document.levels.map((item) => [item.id, item.elevation]),
  );
  return Object.values(gltf.nodes)
    .filter((node) => node.isMesh)
    .map((node) => {
      const element = elements.get(node.userData.element_id || node.name);
      if (!element) return null;
      const floorY = levels.get(level);
      const bounds = node.geometry.boundingBox;
      const crossesLevel =
        bounds && bounds.min.y <= floorY && bounds.max.y > floorY + 0.001;
      if (
        level &&
        element.level !== level &&
        element.to_level !== level &&
        !crossesLevel
      )
        return null;
      const clipping = [];
      if (cutaway && (element.kind === "wall" || element.cutaway)) {
        clipping.push(
          new Plane(
            new Vector3(0, -1, 0),
            (level ? floorY : levels.get(element.level)) +
              (element.bottom ?? 0) +
              0.8,
          ),
        );
      }
      if (
        level &&
        element.level !== level &&
        !["stair", "staircase"].includes(element.kind) &&
        element.to_level !== level
      ) {
        clipping.push(new Plane(new Vector3(0, 1, 0), -floorY + 0.25));
      }
      return (
        <mesh
          key={node.uuid}
          castShadow={!node.material.transparent}
          receiveShadow
          geometry={node.geometry}
          matrix={node.matrixWorld}
          matrixAutoUpdate={false}
          onClick={(event) => {
            if (!isClickGesture(event.delta)) return;
            // Three.js raycasting also hits geometry discarded by material clipping.
            if (
              clipping.some((plane) => plane.distanceToPoint(event.point) < 0)
            )
              return;
            event.stopPropagation();
            onSelect(element.id, event.point.toArray());
            const matrix = scene.components?.[element.id]?.anchor_matrix;
            if (onPick && matrix) {
              const point = event.point
                .clone()
                .applyMatrix4(new Matrix4().set(...matrix.flat()).invert());
              onPick({
                element_id: element.id,
                anchor: point.toArray().map((n) => Math.min(1, Math.max(0, n))),
                note: element.label,
              });
            }
          }}
        >
          <meshStandardMaterial
            color={node.material.color}
            map={node.material.map}
            normalMap={node.material.normalMap}
            normalScale={node.material.normalScale}
            roughnessMap={node.material.roughnessMap}
            metalnessMap={node.material.metalnessMap}
            aoMap={node.material.aoMap}
            aoMapIntensity={node.material.aoMapIntensity}
            emissiveMap={node.material.emissiveMap}
            emissiveIntensity={node.material.emissiveIntensity}
            alphaTest={node.material.alphaTest}
            vertexColors={node.material.vertexColors}
            opacity={node.material.opacity}
            transparent={node.material.transparent}
            depthWrite={!node.material.transparent}
            metalness={node.material.metalness ?? 0}
            side={node.material.side ?? DoubleSide}
            roughness={node.material.roughness ?? 0.85}
            clippingPlanes={clipping}
            emissive={
              selected === element.id ||
              (element.assembly &&
                elements.get(selected)?.assembly === element.assembly)
                ? "#143440"
                : node.material.emissive
            }
          />
        </mesh>
      );
    });
}

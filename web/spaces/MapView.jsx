import { Component, Suspense, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Line, useGLTF } from "@react-three/drei";
import {
  DoubleSide,
  Matrix4,
  Vector3,
  Euler,
  Color,
  SRGBColorSpace,
} from "three";
import { apiUrl, artifact } from "./api";

export class ViewBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <p className="viewer-error" role="alert">
        3D display unavailable: {this.state.error.message}. The map projection
        and downloads remain available.
      </p>
    ) : (
      this.props.children
    );
  }
}

function Surface({ scene }) {
  const gltf = useGLTF(artifact(scene.id, "surface.glb"));
  const transform = useMemo(
    () => new Matrix4().set(...scene.display_from_world.flat()),
    [scene],
  );
  const meshes = Object.values(gltf.nodes).filter((node) => node.isMesh);
  return (
    <group matrix={transform} matrixAutoUpdate={false}>
      {meshes.map((mesh) => (
        <mesh
          key={mesh.uuid}
          geometry={mesh.geometry}
          matrix={mesh.matrixWorld}
          matrixAutoUpdate={false}
        >
          <meshBasicMaterial
            vertexColors
            side={DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function Cloud({ scene, onPick, span }) {
  const positions = useMemo(
    () => new Float32Array(scene.points.flat()),
    [scene],
  );
  const colors = useMemo(
    () =>
      new Float32Array(
        scene.colors.flatMap(([r, g, b]) =>
          new Color()
            .setRGB(r / 255, g / 255, b / 255, SRGBColorSpace)
            .toArray(),
        ),
      ),
    [scene],
  );
  return (
    <points
      onClick={(event) => {
        event.stopPropagation();
        onPick(event.index);
      }}
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={span / 450}
        vertexColors
        sizeAttenuation
        toneMapped={false}
      />
    </points>
  );
}

export function Projection({ scene, observation }) {
  const [lo, hi] = scene.bounds;
  const span = Math.max(hi[0] - lo[0], hi[2] - lo[2], 0.01);
  const x = (p) => 150 + ((p[0] - (lo[0] + hi[0]) / 2) / span) * 260;
  const y = (p) => 150 + ((p[2] - (lo[2] + hi[2]) / 2) / span) * 260;
  const points = scene.points.filter(
    (_, i) => i % Math.max(1, Math.ceil(scene.points.length / 3000)) === 0,
  );
  const position = observation?.display_position;
  return (
    <figure className="projection">
      <svg
        viewBox="0 0 300 300"
        role="img"
        aria-label="Camera-aligned X Z map projection. Not a surveyed floor plan."
      >
        <path d="M150 12V288 M12 150H288" stroke="#d1d0c5" strokeWidth=".5" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(p)}
            cy={y(p)}
            r=".8"
            fill="#767c72"
            opacity=".45"
          />
        ))}
        {scene.cameras.map((c) => (
          <circle
            key={c.id}
            cx={x(c.display_position)}
            cy={y(c.display_position)}
            r="2.4"
            fill="#006783"
          />
        ))}
        {position && (
          <g>
            <circle
              cx={x(position)}
              cy={y(position)}
              r="7"
              fill="#bb522f"
              stroke="white"
              strokeWidth="2"
            />
            <line
              x1={x(position)}
              y1={y(position)}
              x2={x(position) + observation.display_forward[0] * 22}
              y2={y(position) + observation.display_forward[2] * 22}
              stroke="#bb522f"
              strokeWidth="2"
            />
          </g>
        )}
        <text x="15" y="285" fill="#62685d" fontSize="11">
          X / Z
        </text>
      </svg>
      <figcaption>
        Camera-aligned projection
        <br />
        <span>Blue: saved cameras. Orange: latest observation.</span>
      </figcaption>
    </figure>
  );
}

export default function MapView({
  scene,
  observation,
  selectedPoints,
  onPick,
}) {
  const [surface, setSurface] = useState(true);
  const [view, setView] = useState(String(scene.cameras[0]?.id ?? ""));
  const [lo, hi] = scene.bounds;
  const center = lo.map((v, i) => (v + hi[i]) / 2);
  const span = Math.max(...lo.map((v, i) => hi[i] - v), 0.1);
  const position = observation?.display_position;
  const reference = scene.cameras.find((camera) => String(camera.id) === view);
  let camera = {
    position: [
      center[0] + span * 0.8,
      center[1] + span * 0.4,
      center[2] + span,
    ],
  };
  let target = center;
  if (reference) {
    const pose = new Matrix4()
      .set(...reference.world_to_camera.flat(), 0, 0, 0, 1)
      .invert();
    pose
      .premultiply(new Matrix4().set(...scene.display_from_world.flat()))
      .multiply(new Matrix4().makeScale(1, -1, -1));
    const origin = new Vector3().setFromMatrixPosition(pose);
    const forward = new Vector3(0, 0, -1).transformDirection(pose);
    const fy =
      reference.camera_model === "PINHOLE"
        ? reference.params[1]
        : reference.params[0];
    camera = {
      position: origin.toArray(),
      rotation: new Euler().setFromRotationMatrix(pose).toArray(),
      up: new Vector3(0, 1, 0).transformDirection(pose).toArray(),
      fov: (2 * Math.atan(reference.height / (2 * fy)) * 180) / Math.PI,
    };
    target = origin
      .clone()
      .addScaledVector(forward, span / 3)
      .toArray();
  }
  return (
    <section className="map-view" aria-label="3D reconstruction">
      <div className="viewer-toolbar">
        <span>3D model</span>
        <select
          aria-label="3D camera viewpoint"
          value={view}
          onChange={(event) => setView(event.target.value)}
        >
          <option value="">Overview</option>
          {scene.cameras.map((item, index) => (
            <option key={item.id} value={item.id}>
              Capture {index + 1}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={surface}
            onChange={(e) => setSurface(e.target.checked)}
            disabled={!scene.artifacts.includes("surface.glb")}
          />{" "}
          Surface
        </label>
      </div>
      <ViewBoundary key={scene.id}>
        <Canvas
          key={`${scene.id}:${view}`}
          camera={{
            ...camera,
            near: span / 10000,
            far: span * 100,
          }}
          dpr={[1, 1.5]}
          raycaster={{ params: { Points: { threshold: span / 150 } } }}
        >
          <color attach="background" args={["#111a1f"]} />
          <ambientLight intensity={2} />
          {surface && scene.artifacts.includes("surface.glb") ? (
            <Suspense fallback={null}>
              <Surface scene={scene} />
            </Suspense>
          ) : (
            <Cloud scene={scene} span={span} onPick={onPick} />
          )}
          {scene.cameras.map((c) => (
            <mesh key={c.id} position={c.display_position}>
              <sphereGeometry args={[span / 220, 8, 8]} />
              <meshBasicMaterial color="#84d6f0" />
            </mesh>
          ))}
          {selectedPoints.map((index, i) => (
            <mesh key={i} position={scene.points[index]}>
              <sphereGeometry args={[span / 100, 12, 12]} />
              <meshBasicMaterial color="#edd66b" />
            </mesh>
          ))}
          {selectedPoints.length === 2 && (
            <Line
              points={selectedPoints.map((i) => scene.points[i])}
              color="#edd66b"
              lineWidth={2}
            />
          )}
          {position && (
            <mesh position={position}>
              <sphereGeometry args={[span / 70, 16, 16]} />
              <meshBasicMaterial color="#ed8055" />
            </mesh>
          )}
          <OrbitControls target={target} makeDefault />
        </Canvas>
      </ViewBoundary>
      {reference && (
        <a
          className="reference-preview"
          href={apiUrl(`/maps/${scene.id}/images/${reference.name}`)}
          target="_blank"
          rel="noreferrer"
        >
          <img
            src={apiUrl(`/maps/${scene.id}/images/${reference.name}`)}
            alt="Original capture for comparison with the 3D surface"
          />
          <span>Original capture ↗</span>
        </a>
      )}
      <div className="viewer-caption">
        <span>Drag to orbit · Scroll to zoom</span>
        <span>{scene.scale ? "Distance calibrated" : "Scale unverified"}</span>
      </div>
    </section>
  );
}

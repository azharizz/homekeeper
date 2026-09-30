import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html, Line, PerspectiveCamera } from "@react-three/drei";
import { Shape, Path } from "three";
import { pathPosition } from "../walkthrough-math";

const noRaycast = () => null;

export function WalkingArea({ area }) {
  return area.polygons.map((polygon, index) => {
    const ring = (points, Type) => {
      const path = new Type();
      points.forEach(([x, z], i) =>
        i ? path.lineTo(x, -z) : path.moveTo(x, -z),
      );
      path.closePath();
      return path;
    };
    const shape = ring(polygon.outer, Shape);
    shape.holes = polygon.holes.map((hole) => ring(hole, Path));
    return (
      <mesh
        key={index}
        position={[0, area.height + 0.045, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={noRaycast}
      >
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial
          color="#7de4bc"
          transparent
          opacity={0.3}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
    );
  });
}

function WalkMarker({ point, label, color }) {
  return (
    <group position={point}>
      <mesh position={[0, 0.09, 0]} raycast={noRaycast}>
        <sphereGeometry args={[0.075, 12, 8]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      <Html position={[0, 0.2, 0]} center style={{ pointerEvents: "none" }}>
        <span className="walk-marker" style={{ borderColor: color }}>
          {label}
        </span>
      </Html>
    </group>
  );
}

export function WalkthroughPath({
  route,
  start,
  target,
  distance,
  validStart = true,
}) {
  const first = start || route?.points[0];
  const end = route?.points.at(-1);
  const destination = route?.target_position || target;
  return (
    <group>
      {route?.distance_m > 0 && (
        <Line
          points={route.points.map(([x, y, z]) => [x, y + 0.05, z])}
          color="#0abeff"
          lineWidth={4}
          raycast={noRaycast}
        />
      )}
      {first && (
        <WalkMarker
          point={first}
          label="Start"
          color={validStart ? "#7de4bc" : "#ff967f"}
        />
      )}
      {destination && (
        <WalkMarker point={destination} label="Object" color="#ffc878" />
      )}
      {end && (
        <>
          <WalkMarker point={end} label="Stop" color="#0abeff" />
          <Line
            points={[[end[0], end[1] + 0.08, end[2]], destination]}
            color="#ffc878"
            lineWidth={1}
            dashed
            dashSize={0.08}
            gapSize={0.06}
            raycast={noRaycast}
          />
          {distance > 0 && (
            <WalkMarker
              point={pathPosition(route.points, distance)}
              label="You"
              color="#ffffff"
            />
          )}
        </>
      )}
    </group>
  );
}

export function WalkthroughCamera({ walk, clock, onProgress, stepLength }) {
  const camera = useRef();
  const reported = useRef(-1);
  const { invalidate } = useThree();
  useFrame((_, delta) => {
    if (!camera.current) return;
    const route = walk.route;
    if (walk.playing)
      clock.current = Math.min(
        route.distance_m,
        clock.current + Math.min(delta, 0.1) * stepLength,
      );
    const position = pathPosition(route.points, clock.current);
    position[1] += route.profile.eye_height_m;
    const look =
      clock.current >= route.distance_m - 0.01
        ? route.target_position
        : pathPosition(
            route.points,
            Math.min(route.distance_m, clock.current + 0.4),
          );
    camera.current.position.fromArray(position);
    camera.current.lookAt(
      look[0],
      clock.current >= route.distance_m - 0.01 ? look[1] : position[1],
      look[2],
    );
    camera.current.rotateY(walk.look || 0);
    if (walk.playing) {
      if (
        Math.abs(clock.current - reported.current) >= 0.1 ||
        clock.current >= route.distance_m
      ) {
        reported.current = clock.current;
        onProgress(clock.current);
      }
      invalidate();
    }
  });
  return (
    <PerspectiveCamera
      ref={camera}
      makeDefault
      fov={60}
      near={0.02}
      far={1000}
    />
  );
}

import { Component, Suspense, useCallback, useEffect, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Line, PerspectiveCamera, useGLTF } from "@react-three/drei";
import { ArchitectureMesh, FittedCamera, revisionURL } from "./spaces/architecture/Scene";
import { currentGuidePose, currentGuideRoute } from "./guide-debug-state.js";
import "./guide-debug.css";

class DebugViewBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    return this.state.error ? (
      <p className="guide-debug-model-error" role="alert">
        Saved model unavailable: {this.state.error.message}. Tracking diagnostics remain available.
      </p>
    ) : this.props.children;
  }
}

const format = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
const vector = (values) => values ? values.map(value => format(value, 3)).join(", ") : "unknown";
const readOnlySelection = () => null;
const frustumCorners = [[-0.5, -0.33, -0.6], [0.5, -0.33, -0.6], [0.5, 0.33, -0.6], [-0.5, 0.33, -0.6]];
const frustumLines = [frustumCorners[0], frustumCorners[1], frustumCorners[2], frustumCorners[3], frustumCorners[0], [0, 0, 0], frustumCorners[1], [0, 0, 0], frustumCorners[2], [0, 0, 0], frustumCorners[3]];

function DebugModel({ scene, level, cutaway, selected, onLoaded }) {
  useGLTF(revisionURL(scene, "surface.glb"));
  const invalidate = useThree(state => state.invalidate);
  useEffect(() => {
    onLoaded();
    invalidate();
    // Camera and OrbitControls finish their mount effects before this draw.
    const frame = requestAnimationFrame(invalidate);
    return () => cancelAnimationFrame(frame);
  }, [scene, level, cutaway, selected, onLoaded, invalidate]);
  return <ArchitectureMesh scene={scene} level={level} cutaway={cutaway} selected={selected} onSelect={readOnlySelection} />;
}

function DebugPath({ route, target, span }) {
  const destination = route?.target_position || target;
  const end = route?.points.at(-1);
  return (
    <group>
      {route?.distance_m > 0 && <Line points={route.points.map(([x, y, z]) => [x, y + 0.05, z])} color="#0abeff" lineWidth={3} depthTest={false} />}
      {destination && <mesh position={destination}>
        <sphereGeometry args={[Math.max(span / 100, 0.06), 12, 8]} />
        <meshBasicMaterial color="#ffc878" depthTest={false} />
      </mesh>}
      {end && destination && <Line points={[[end[0], end[1] + 0.08, end[2]], destination]} color="#ffc878" lineWidth={1} dashed dashSize={0.08} gapSize={0.06} depthTest={false} />}
    </group>
  );
}

function PhoneFrustum({ pose, span }) {
  return (
    <group position={pose.position} quaternion={pose.quaternion} scale={Math.min(1, span / 5)}>
      <Line points={frustumLines} color="#b8ffcf" lineWidth={2} depthTest={false} />
      <mesh>
        <sphereGeometry args={[0.055, 8, 8]} />
        <meshBasicMaterial color="#b8ffcf" depthTest={false} />
      </mesh>
    </group>
  );
}

export default function GuideDebug({ scene, tracking, target, route, onStartXR, onStopTracking, simulation, simulated = false }) {
  const [view, setView] = useState("pov");
  const [clock, setClock] = useState(() => ({ now: Date.now() / 1000, hidden: document.hidden }));
  const [loadedModel, setLoadedModel] = useState(null);
  const modelKey = scene ? `${scene.id}:${scene.revision}:${scene.artifact_revision}` : null;
  const onModelLoaded = useCallback(() => setLoadedModel(modelKey), [modelKey]);
  useEffect(() => {
    const update = () => setClock({ now: Date.now() / 1000, hidden: document.hidden });
    update();
    const timer = tracking?.status === "tracking" ? setInterval(update, 250) : null;
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [tracking?.status]);
  const now = Math.max(clock.now, Date.now() / 1000);
  const pose = simulated ? simulation : currentGuidePose(tracking, scene, now, clock.hidden);
  const currentRoute = simulated ? null : currentGuideRoute(route, scene, target);
  const pov = view === "pov" && !!pose;
  const bounds = scene?.bounds;
  const modelReady = !!scene?.architecture?.elements && !!scene?.architecture?.levels &&
    scene.artifacts?.includes("surface.glb") && Array.isArray(bounds) && bounds.length === 2 &&
    bounds.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
  const span = modelReady ? Math.max(...bounds[0].map((value, axis) => bounds[1][axis] - value), 1) : 1;
  const targetBounds = scene?.components?.[target?.elementId]?.bounds;
  const targetPosition = targetBounds?.length === 2 && targetBounds.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))
    ? targetBounds[0].map((value, axis) => (value + targetBounds[1][axis]) / 2) : null;
  const age = Number.isFinite(tracking?.capturedAt) ? now - tracking.capturedAt : null;
  const status = tracking?.status === "tracking" && !pose ? "unknown" : tracking?.status || "stopped";
  const remaining = Number.isFinite(currentRoute?.remaining_m) ? currentRoute.remaining_m : null;
  const progress = Number.isFinite(currentRoute?.progress_m) ? `${format(currentRoute.progress_m)} m` :
    Number.isFinite(currentRoute?.progress) ? `${format(currentRoute.progress * 100, 0)}%` : "not provided";
  return (
    <section className={`guide-debug${simulated ? " guide-debug-simulation" : ""}`} aria-label="Live guide tracking debugger">
      <header className="guide-debug-heading">
        <div><h2>{simulated ? "Simulation · debug" : "Live guide · debug"}</h2><p>{simulated ? "Authored camera path · synchronized to video time" : "Model alignment is an estimate, not a safe walking certification."}</p></div>
        {!simulated && <div className="guide-debug-controls">
          <button type="button" onClick={onStartXR} disabled={!onStartXR || !scene} aria-label="Start AR tracking with device motion">Start AR tracking</button>
          <button type="button" onClick={onStopTracking} disabled={!onStopTracking} aria-label="Stop camera and AR position tracking">Stop tracking</button>
        </div>}
      </header>
      <div className="guide-debug-toolbar" role="group" aria-label="Virtual model viewpoint">
        <button type="button" aria-pressed={view === "pov"} onClick={() => setView("pov")}>Virtual phone POV</button>
        <button type="button" aria-pressed={view === "overview"} onClick={() => setView("overview")}>Overhead overview</button>
        <span>{simulated ? "Simulated camera · not a localized phone" : pov ? "Live pose · approximate 60° display lens" : "Room overview · not your current view"}</span>
      </div>
      <div className="guide-debug-viewport">
        {modelReady ? (
          <DebugViewBoundary key={`${scene.id}:${scene.revision}:${scene.artifact_revision}`}>
            <Canvas frameloop="demand" dpr={1} camera={{ fov: 60, near: 0.02, far: span * 100 }} gl={{ localClippingEnabled: true, antialias: false }}>
              <color attach="background" args={["#102a36"]} />
              <ambientLight intensity={1.8} />
              <directionalLight position={[span, span * 2, span]} intensity={2} />
              <Suspense fallback={null}>
                <DebugModel scene={scene} level={pov ? "" : (scene.architecture.elements.find(element => element.id === target?.floorId)?.level || "")} cutaway={!pov} selected={target?.elementId} onLoaded={onModelLoaded} />
              </Suspense>
              <DebugPath route={simulation ? { points: simulation.points, distance_m: 1, target_position: simulation.target } : currentRoute} target={targetPosition} span={span} />
              {pov ? (
                <PerspectiveCamera key="live" makeDefault position={pose.position} quaternion={pose.quaternion} fov={simulation?.fov || 60} near={0.02} far={span * 100} />
              ) : (
                <FittedCamera key={`overview:${scene.id}:${scene.revision}`} bounds={bounds} direction={[0, 1, 0.001]} span={span} />
              )}
              {!pov && pose && <PhoneFrustum pose={pose} span={span} />}
            </Canvas>
            {loadedModel !== modelKey && <div className="guide-debug-model-loading" role="status">Loading saved model…</div>}
          </DebugViewBoundary>
        ) : (
          <p className="guide-debug-model-error" role="status">{scene ? "Saved structured model is unavailable." : "Select a saved Space by voice to inspect its model."}</p>
        )}
        {!pose && <div className="guide-debug-unknown" role="status"><strong>{simulated ? "Simulation unavailable" : "Position unknown"}</strong><span>{simulated ? "Load the original Aria demo Space, revision 1." : tracking?.reason || "A fresh pose aligned to this model is required. No last-known phone view is shown."}</span></div>}
      </div>
      <dl className="guide-debug-metrics">
        <div><dt>{simulated ? "Mode / timeline" : "Tracking / source"}</dt><dd>{simulated ? `Simulation / ${format(simulation?.time)} s` : `${status} / ${tracking?.source || "none"}`}</dd></div>
        <div><dt>Model / revision</dt><dd>{scene?.id || "none"} / {scene?.revision ?? "—"}</dd></div>
        {!simulated && <><div><dt>Pose model / revision</dt><dd>{tracking?.mapId || "none"} / {tracking?.revision ?? "—"}</dd></div>
        <div><dt>Sample age</dt><dd>{age === null ? "unknown" : age < 0 ? "invalid future timestamp" : `${format(age)} s`}</dd></div></>}
        <div><dt>Position · x, y, z (model m)</dt><dd>{vector(pose?.position)}</dd></div>
        <div><dt>Rotation · x, y, z, w</dt><dd>{vector(pose?.quaternion)}</dd></div>
        {!simulated && <><div><dt>Match inliers / error</dt><dd>{Number.isFinite(tracking?.inliers) ? tracking.inliers : "—"} / {format(tracking?.reprojectionErrorPx)} px</dd></div>
        <div><dt>Match latency</dt><dd>{format(tracking?.latencyMs, 0)} ms</dd></div>
        <div><dt>Tracking detail</dt><dd>{tracking?.reason || "—"}</dd></div></>}
        <div><dt>Target / floor</dt><dd>{simulated ? "Coffee table / main" : target ? `${target.label || target.elementId} / ${target.floorId}` : "Not selected"}</dd></div>
        <div><dt>Model route</dt><dd>{simulated ? "Authored demo path" : currentRoute ? `${format(currentRoute.distance_m)} m · ${currentRoute.start_is_automatic ? "virtual start" : "supplied start"}` : route ? "Not current for this model / target" : "Not provided"}</dd></div>
        <div><dt>{simulated ? "Simulation progress" : "Remaining / progress"}</dt><dd>{simulation ? `${format(simulation.progress * 100, 0)}%` : pose && currentRoute ? `${remaining === null ? "not provided" : `${format(remaining)} m`} / ${progress}` : "unknown"}</dd></div>
      </dl>
      <p className="guide-debug-legend">{simulated ? "Green: simulated camera. Amber: coffee table. Blue: authored demo path. Speech pauses also freeze the virtual camera." : "Green: current phone pose (approximate frustum). Amber: saved target. Blue: model-only route. The overview remains inspectable when tracking is lost."}</p>
    </section>
  );
}

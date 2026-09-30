import { Suspense, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { useQuery } from "@tanstack/react-query";
import { ViewBoundary } from "./MapView";
import { post, request } from "./api";
import PhotosPanel from "./architecture/PhotosPanel";
import Measurements from "./Measurements";
import { anchorWorld } from "./architecture/anchors";
import Walkthrough from "./Walkthrough";
import { WalkthroughCamera, WalkthroughPath, WalkingArea } from "./walkthrough/Scene";
import { insideWalkingArea } from "./walkthrough-math";
import { Icon } from "./ui";
import DetailsPanel from "./architecture/DetailsPanel";
import FloorPlan from "./architecture/FloorPlan";
import ObjectPanel from "./architecture/ObjectPanel";
import {
  ArchitectureMesh,
  FittedCamera,
  revisionURL,
} from "./architecture/Scene";

export default function ArchitectureView({ scene, children, observation }) {
  const doc = scene.architecture;
  const [requestedLevel, setLevel] = useState(doc.levels[0].id);
  const level = doc.levels.some((item) => item.id === requestedLevel)
    ? requestedLevel
    : doc.levels[0].id;
  const [showAllFloors, setAllFloors] = useState(doc.levels.length > 1);
  const allFloors = showAllFloors && doc.levels.length > 1;
  const [cutaway, setCutaway] = useState(true);
  const [selected, setSelected] = useState("");
  const [view, setView] = useState("entry");
  const [focus, setFocus] = useState(false);
  const [photo, setPhoto] = useState(scene.frames[0].name);
  const [picked, setPicked] = useState(null);
  const [measurePoints, setMeasurePoints] = useState([]);
  const [tool, setTool] = useState("");
  const [walk, setWalk] = useState({
    route: null,
    target: "",
    start: null,
    distance: 0,
    mode: "overview",
    playing: false,
    pending: false,
    pickStart: false,
    profile: {
      radius_m: 0.3,
      body_height_m: 1.8,
      eye_height_m: 1.65,
      stop_distance_m: 0.4,
    },
    error: null,
  });
  const [stepLength, setStepLength] = useState(0.65);
  const walkClock = useRef(0);
  const walking = tool === "walk" && walk.route && walk.mode === "firstPerson";
  const updateWalk = (patch) => {
    if (
      patch.start !== undefined ||
      (patch.target !== undefined && !patch.route) ||
      patch.profile !== undefined ||
      patch.floor !== undefined
    ) {
      patch = {
        ...patch,
        route: null,
        distance: 0,
        playing: false,
        mode: "overview",
        error: null,
      };
    }
    if (patch.distance !== undefined) walkClock.current = patch.distance;
    if (patch.pickStart) {
      setView("plan");
      setCutaway(true);
      setFocus(false);
    }
    setWalk((previous) => ({ ...previous, ...patch }));
  };
  const toolButtons = useRef({});
  const closeTool = () => {
    toolButtons.current[tool]?.focus();
    updateWalk({ playing: false, mode: "overview" });
    setTool("");
  };
  const element = doc.elements.find((item) => item.id === selected);
  const objects = [
    ...doc.elements
      .reduce((groups, item) => {
        const key = item.assembly || item.id;
        if (!groups.has(key)) groups.set(key, item);
        return groups;
      }, new Map())
      .values(),
  ];
  const walkFloor =
    walk.start?.floor_id ||
    walk.floor ||
    doc.elements
      .filter((e) => e.kind === "slab" && e.level === level)
      .sort((a, b) => a.top - b.top)[0]?.id;
  const { stop_distance_m, ...bodyProfile } = walk.profile;
  const area = useQuery({
    queryKey: [
      "walking-area",
      scene.id,
      scene.revision,
      walkFloor,
      bodyProfile,
    ],
    queryFn: () =>
      post(`/maps/${scene.id}/architecture/walkthrough-area`, {
        expected_revision: scene.revision,
        floor_id: walkFloor,
        ...bodyProfile,
      }),
    enabled: tool === "walk" && !!walkFloor,
  });
  const validStart =
    !!walk.start &&
    !!area.data &&
    insideWalkingArea(walk.start.point, area.data.polygons);
  const placeStart = (point, confirm = true) => {
    if (!area.data || walk.pending) return;
    const valid = insideWalkingArea(point, area.data.polygons);
    updateWalk({
      start: { floor_id: area.data.floor_id, point },
      pickStart: !confirm || !valid,
    });
  };
  const targetParts = doc.elements.filter(
    (e) =>
      e.id === walk.target ||
      (e.assembly &&
        e.assembly ===
          doc.elements.find((v) => v.id === walk.target)?.assembly),
  );
  const targetBounds = targetParts
    .map((e) => scene.components?.[e.id]?.bounds)
    .filter(Boolean);
  const targetPosition = targetBounds.length
    ? [0, 1, 2].map(
        (axis) =>
          (Math.min(...targetBounds.map((b) => b[0][axis])) +
            Math.max(...targetBounds.map((b) => b[1][axis]))) /
          2,
      )
    : null;
  const select = (id, point) => {
    if (tool === "walk") {
      if (walk.pending || walking) return;
      const item = doc.elements.find((e) => e.id === id);
      if (walk.pickStart) {
        if (
          point &&
          area.data &&
          point[1] >= area.data.height - 0.001 &&
          point[1] <= area.data.height + 0.03
        ) {
          placeStart([point[0], point[2]]);
        } else
          updateWalk({
            error:
              "Choose floor space in the highlighted area, or pick on the floor plan.",
          });
      } else if (["box", "solid", "asset", "rail"].includes(item.kind)) {
        const target = objects.find((e) =>
          item.assembly ? e.assembly === item.assembly : e.id === id,
        );
        setSelected(target.id);
        updateWalk({ target: target.id });
      }
      return;
    }
    if (tool !== "photos" && tool !== "measure") setTool("objects");
    const clicked = doc.elements.find((item) => item.id === id);
    setSelected(
      objects.find((item) =>
        clicked.assembly ? item.assembly === clicked.assembly : item.id === id,
      ).id,
    );
  };
  const group = element
    ? doc.elements.filter(
        (item) =>
          item.id === selected ||
          (element.assembly && item.assembly === element.assembly),
      )
    : [];
  const componentBounds = group
    .map((item) => scene.components?.[item.id]?.bounds)
    .filter(Boolean);
  const focusBounds = componentBounds.length
    ? [
        [0, 1, 2].map((axis) =>
          Math.min(...componentBounds.map((b) => b[0][axis])),
        ),
        [0, 1, 2].map((axis) =>
          Math.max(...componentBounds.map((b) => b[1][axis])),
        ),
      ]
    : null;
  const floorY = doc.levels.find((item) => item.id === level).elevation;
  const visibleBounds = doc.elements.flatMap((item) => {
    const bounds = scene.components?.[item.id]?.bounds;
    if (!bounds) return [];
    const b = bounds.map((point) => [...point]);
    if (
      !allFloors &&
      item.level !== level &&
      item.to_level !== level &&
      !(b[0][1] <= floorY && b[1][1] > floorY + 0.001)
    )
      return [];
    if (cutaway && (item.kind === "wall" || item.cutaway))
      b[1][1] = Math.min(
        b[1][1],
        (allFloors
          ? doc.levels.find((value) => value.id === item.level).elevation
          : floorY) +
          (item.bottom ?? 0) +
          0.8,
      );
    if (
      !allFloors &&
      item.level !== level &&
      !["stair", "staircase"].includes(item.kind)
    )
      b[0][1] = Math.max(b[0][1], floorY - 0.25);
    return b[0][1] <= b[1][1] ? [b] : [];
  });
  const bounds =
    focus && focusBounds
      ? focusBounds
      : visibleBounds.length
        ? [
            [0, 1, 2].map((axis) =>
              Math.min(...visibleBounds.map((b) => b[0][axis])),
            ),
            [0, 1, 2].map((axis) =>
              Math.max(...visibleBounds.map((b) => b[1][axis])),
            ),
          ]
        : scene.bounds;
  const span = Math.max(
    ...scene.bounds[0].map((v, i) => scene.bounds[1][i] - v),
    1,
  );
  const direction = {
    entry: [0.6, 0.7, -0.9],
    reverse: [-0.6, 0.7, 0.9],
    side: [-1, 0.55, 0.1],
    plan: [0, 1, 0.001],
  }[view];
  const geometry = useQuery({
    queryKey: ["geometry-checks", scene.id, scene.revision],
    queryFn: () => request(`/maps/${scene.id}/architecture/checks`),
    enabled: tool === "details",
  });
  const issueCount = geometry.data?.issue_count;
  const toggleTool = (next) => {
    updateWalk({ playing: false, mode: "overview" });
    if (next === "walk") {
      setAllFloors(false);
      setFocus(false);
      if (!walk.start) updateWalk({ pickStart: true });
    }
    setTool(tool === next ? "" : next);
  };
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>{scene.name}</h1>
          <p className="hint">
            Structured model · {scene.total_frames} photos · Revision{" "}
            {scene.revision}
          </p>
        </div>
        <details className="export-menu">
          <summary>
            <Icon name="download" /> Export
          </summary>
          <div>
            {scene.artifacts.map((name) => (
              <a key={name} href={revisionURL(scene, name)} download>
                {name === "surface.glb"
                  ? "3D model (.glb)"
                  : "Editable model (.json)"}
              </a>
            ))}
          </div>
        </details>
      </div>
      <div className="workspace-actions" role="group" aria-label="Model tools">
        {[
          ["photos", "photo", "Photos"],
          ["objects", "cube", "Objects"],
          ["measure", "ruler", "Measure"],
          ["walk", "walk", "Walkthrough"],
          ["camera", "camera", "Camera"],
          ["details", "info", "Details"],
        ].map(([id, icon, label]) => (
          <button
            key={id}
            ref={(node) => {
              toolButtons.current[id] = node;
            }}
            aria-pressed={tool === id}
            onClick={() => toggleTool(id)}
          >
            <Icon name={icon} />
            {label}
            {id === "details" && issueCount > 0 && (
              <span className="count">{issueCount}</span>
            )}
          </button>
        ))}
      </div>
      <div
        className={`model-layout ${tool ? "has-panel" : ""}`}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && walking) {
            event.preventDefault();
            event.stopPropagation();
            updateWalk({ mode: "overview", playing: false });
          }
        }}
      >
        <div className="spatial-column">
          <section
            className="map-view"
            aria-label="Architectural model"
            tabIndex={tool === "walk" ? 0 : undefined}
          >
            <div className="viewer-toolbar">
              <select
                aria-label="Visible floors"
                disabled={Boolean(walking) || walk.pending}
                value={allFloors ? "all" : level}
                onChange={(e) => {
                  setAllFloors(e.target.value === "all");
                  if (e.target.value !== "all") setLevel(e.target.value);
                  setFocus(false);
                  updateWalk({
                    route: null,
                    start: null,
                    floor: null,
                    pickStart: tool === "walk",
                    target: "",
                    distance: 0,
                    playing: false,
                  });
                }}
              >
                {doc.levels.length > 1 && tool !== "walk" && (
                  <option value="all">All floors</option>
                )}
                {doc.levels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Model viewpoint"
                disabled={Boolean(walking)}
                value={view}
                onChange={(e) => setView(e.target.value)}
              >
                <option value="entry">Entry view</option>
                <option value="reverse">Reverse view</option>
                <option value="side">Side view</option>
                <option value="plan">Top view</option>
              </select>
              <button
                aria-pressed={cutaway}
                disabled={Boolean(walking)}
                onClick={() => setCutaway(!cutaway)}
              >
                Cutaway
              </button>
              {element && tool !== "walk" && (
                <button
                  aria-pressed={focus}
                  disabled={!focusBounds}
                  onClick={() => {
                    setFocus(!focus);
                    setLevel(element.level);
                  }}
                >
                  <Icon name="focus" size={16} />
                  Focus
                </button>
              )}
            </div>
            <ViewBoundary key={`${scene.id}:${scene.revision}`}>
              <Canvas
                frameloop="demand"
                shadows
                key={`${level}:${allFloors}:${view}:${focus}:${focus ? selected : ""}:${cutaway}:${tool === "walk" && walk.pickStart}`}
                camera={{ fov: 42, near: 0.01, far: span * 100 }}
                dpr={[1, 1.5]}
                gl={{ localClippingEnabled: true }}
              >
                <color attach="background" args={["#172630"]} />
                <ambientLight intensity={0.7} />
                <hemisphereLight args={["#fff9ef", "#687983", 1.7]} />
                <directionalLight
                  position={[8, 16, -6]}
                  intensity={2}
                  castShadow
                  shadow-mapSize={[2048, 2048]}
                  shadow-camera-left={-span}
                  shadow-camera-right={span}
                  shadow-camera-top={span}
                  shadow-camera-bottom={-span}
                  shadow-camera-far={span * 8}
                  shadow-normalBias={0.02}
                />
                <Suspense fallback={null}>
                  <ArchitectureMesh
                    scene={scene}
                    level={allFloors ? "" : level}
                    cutaway={walking ? false : cutaway}
                    selected={
                      walking ? "" : tool === "walk" ? walk.target : selected
                    }
                    onSelect={select}
                    onPick={(point) => {
                      setPicked(point);
                      if (tool === "measure")
                        setMeasurePoints((previous) =>
                          previous.length < 2 ? [...previous, point] : [point],
                        );
                    }}
                  />
                </Suspense>
                {measurePoints.length === 2 && (
                  <Line
                    points={measurePoints.map((p) => anchorWorld(scene, p))}
                    color="#0abeff"
                    lineWidth={3}
                    depthTest={false}
                  />
                )}
                {tool !== "walk" &&
                  observation?.status === "localized" &&
                  observation.map_revision === scene.revision && (
                    <mesh position={observation.display_position}>
                      <sphereGeometry args={[0.08, 16, 12]} />
                      <meshBasicMaterial color="#0abeff" depthTest={false} />
                    </mesh>
                  )}
                {tool === "walk" && walk.pickStart && area.data && (
                  <WalkingArea area={area.data} />
                )}
                {tool === "walk" && !walking && (
                  <WalkthroughPath
                    route={walk.route}
                    distance={walk.distance}
                    start={
                      walk.start && [
                        walk.start.point[0],
                        area.data?.height ?? floorY,
                        walk.start.point[1],
                      ]
                    }
                    target={targetPosition}
                    validStart={validStart}
                  />
                )}
                {walking ? (
                  <WalkthroughCamera
                    walk={walk}
                    clock={walkClock}
                    stepLength={stepLength}
                    onProgress={(distance) =>
                      updateWalk({
                        distance,
                        playing: distance < walk.route.distance_m,
                      })
                    }
                  />
                ) : (
                  <FittedCamera
                    bounds={bounds}
                    direction={direction}
                    span={span}
                    picking={tool === "walk" && walk.pickStart}
                  />
                )}
              </Canvas>
            </ViewBoundary>
            <div className="viewer-caption">
              <span>
                {walking
                  ? "Virtual walkthrough · Escape to overview"
                  : walk.pickStart && tool === "walk"
                    ? "Click clear floor space to set a virtual start"
                    : "Drag to orbit · Scroll to zoom"}
              </span>
              <span>
                {measurePoints.length === 2
                  ? `${Math.hypot(...anchorWorld(scene, measurePoints[0]).map((v, i) => v - anchorWorld(scene, measurePoints[1])[i])).toFixed(3)} m · Estimated`
                  : "Metres · Estimated dimensions"}
              </span>
            </div>
          </section>
          <details className="plan-overview" open>
            <summary>
              <Icon name="plan" size={16} /> Floor plan
            </summary>
            {allFloors && doc.levels.length > 1 && (
              <select
                aria-label="Plan floor"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
              >
                {doc.levels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            <FloorPlan
              scene={scene}
              level={level}
              selected={selected}
              onSelect={select}
              walk={tool === "walk" ? { ...walk, targetPosition } : null}
              area={area.data}
              onStart={placeStart}
            />
          </details>
        </div>
        {tool && (
          <aside
            className="inspector"
            aria-label={`${tool} tools`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeTool();
              }
            }}
          >
            <div className="panel-heading">
              <h2>
                {
                  {
                    photos: "Photos",
                    objects: "Objects",
                    camera: "Camera",
                    measure: "Measure",
                    walk: "Walkthrough",
                    details: "Model details",
                  }[tool]
                }
              </h2>
              <button
                className="icon-button"
                aria-label="Close model tools"
                onClick={closeTool}
              >
                <Icon name="close" />
              </button>
            </div>
            <PhotosPanel
              scene={scene}
              photo={photo}
              onPhoto={setPhoto}
              picked={picked}
              active={tool === "photos"}
            />
            {tool === "objects" && (
              <ObjectPanel
                scene={scene}
                objects={objects}
                selected={selected}
                element={element}
                group={group}
                focusBounds={focusBounds}
                onClear={() => { setSelected(""); setFocus(false); }}
                onSelect={(id) => { select(id); setFocus(false); }}
                onShowPhoto={(name) => { setPhoto(name); setTool("photos"); }}
              />
            )}
            {tool === "camera" && children}
            {tool === "walk" && (
              <Walkthrough
                key={level}
                scene={scene}
                level={level}
                objects={objects}
                walk={walk}
                onChange={updateWalk}
                stepLength={stepLength}
                onStepLength={setStepLength}
                area={area.data}
                areaPending={area.isFetching}
                areaError={area.error}
                validStart={validStart}
              />
            )}
            {tool === "measure" && (
              <Measurements
                key={scene.revision}
                scene={scene}
                points={measurePoints}
                onPoints={setMeasurePoints}
              />
            )}
            {tool === "details" && (
              <DetailsPanel
                scene={scene}
                geometry={geometry}
                onIssue={(id) => {
                  select(id);
                  setLevel(doc.elements.find((item) => item.id === id).level);
                  setFocus(true);
                }}
              />
            )}
          </aside>
        )}
      </div>
    </>
  );
}

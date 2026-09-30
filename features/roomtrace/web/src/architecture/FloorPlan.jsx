import { pathPosition, insideWalkingArea } from "../walkthrough-math";

function footprint(element, scene) {
  if (element.polygon) return element.polygon;
  if (!["box", "solid", "asset"].includes(element.kind)) return null;
  return scene.components?.[element.id]?.footprint || null;
}

export default function FloorPlan({
  scene,
  level,
  selected,
  onSelect,
  walk,
  area,
  onStart,
}) {
  const [low, high] = scene.bounds;
  const span = Math.max(high[0] - low[0], high[2] - low[2]);
  const x = (v) => 20 + ((v - low[0]) * 260) / span;
  const z = (v) => 20 + ((v - low[2]) * 260) / span;
  const polygon = (ring) =>
    `M${ring.map(([a, b]) => `${x(a)},${z(b)}`).join("L")}Z`;
  const elevation = scene.architecture.levels.find(
    (item) => item.id === level,
  ).elevation;
  const elements = scene.architecture.elements.filter((item) => {
    const bounds = scene.components?.[item.id]?.bounds;
    return (
      item.level === level ||
      item.to_level === level ||
      (item.kind === "wall" &&
        bounds &&
        bounds[0][1] <= elevation &&
        bounds[1][1] > elevation)
    );
  });
  return (
    <figure className="projection">
      <svg
        viewBox="0 0 300 300"
        role={walk?.pickStart ? "button" : "img"}
        tabIndex={walk?.pickStart ? 0 : undefined}
        aria-label={
          walk?.pickStart
            ? "Choose start on floor plan. Arrow keys move the start; Enter confirms."
            : "Selected floor architectural plan, dimensions estimated"
        }
        onClickCapture={(event) => {
          if (!walk?.pickStart || !area) return;
          event.stopPropagation();
          const point = new DOMPoint(
            event.clientX,
            event.clientY,
          ).matrixTransform(event.currentTarget.getScreenCTM().inverse());
          onStart([
            ((point.x - 20) * span) / 260 + low[0],
            ((point.y - 20) * span) / 260 + low[2],
          ]);
        }}
        onKeyDown={(event) => {
          if (!walk?.pickStart || !area) return;
          const moves = {
            ArrowLeft: [-0.1, 0],
            ArrowRight: [0.1, 0],
            ArrowUp: [0, -0.1],
            ArrowDown: [0, 0.1],
          };
          const point = walk.start?.point || [
            (low[0] + high[0]) / 2,
            (low[2] + high[2]) / 2,
          ];
          if (moves[event.key]) {
            event.preventDefault();
            onStart(
              point.map((v, i) => v + moves[event.key][i]),
              false,
            );
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onStart(point);
          }
        }}
      >
        <defs>
          <marker
            id="stair-arrow"
            markerWidth="5"
            markerHeight="5"
            refX="4"
            refY="2.5"
            orient="auto"
          >
            <path d="M0 0L5 2.5L0 5" fill="#006783" />
          </marker>
        </defs>
        {elements
          .filter((item) => footprint(item, scene))
          .map((item) => (
            <path
              key={item.id}
              d={
                scene.components?.[item.id]?.surfaces
                  ? scene.components[item.id].surfaces
                      .map(
                        (surface) =>
                          polygon(surface.polygon) +
                          surface.holes.map(polygon).join(""),
                      )
                      .join("")
                  : polygon(footprint(item, scene)) +
                    (item.holes || []).map(polygon).join("")
              }
              fill={item.kind === "zone" ? "none" : item.color}
              fillRule="evenodd"
              stroke={selected === item.id ? "#006f9d" : "#637061"}
              strokeWidth={selected === item.id ? 2 : 0.5}
              onClick={() => onSelect(item.id)}
            />
          ))}
        {elements
          .filter((item) => item.kind === "wall")
          .map((item) => {
            const length = Math.hypot(
              item.end[0] - item.start[0],
              item.end[1] - item.start[1],
            );
            const point = (distance) =>
              item.start.map(
                (v, i) => v + ((item.end[i] - v) * distance) / length,
              );
            return (
              <g key={item.id} onClick={() => onSelect(item.id)}>
                <line
                  x1={x(item.start[0])}
                  y1={z(item.start[1])}
                  x2={x(item.end[0])}
                  y2={z(item.end[1])}
                  stroke={selected === item.id ? "#006f9d" : "#354638"}
                  strokeWidth={Math.max(1.5, (item.thickness * 260) / span)}
                />
                {item.openings
                  .filter((opening) => {
                    const sill =
                      scene.architecture.levels.find(
                        (value) => value.id === item.level,
                      ).elevation +
                      item.bottom +
                      opening.sill;
                    return (
                      sill <= elevation + 1 &&
                      sill + opening.height >= elevation + 1
                    );
                  })
                  .map((opening, index) => {
                    const a = point(opening.offset),
                      b = point(opening.offset + opening.width);
                    return (
                      <line
                        key={index}
                        x1={x(a[0])}
                        y1={z(a[1])}
                        x2={x(b[0])}
                        y2={z(b[1])}
                        stroke={
                          opening.kind === "window" ? "#8dc5c7" : "#f3f1e9"
                        }
                        strokeWidth={Math.max(
                          2,
                          (item.thickness * 260) / span + 0.5,
                        )}
                      />
                    );
                  })}
              </g>
            );
          })}
        {elements
          .filter((item) => ["stair", "staircase"].includes(item.kind))
          .flatMap((item) =>
            item.flights
              ? item.flights.map((flight) => ({
                  ...flight,
                  id: `${item.id}_${flight.id}`,
                }))
              : [item],
          )
          .map((item) => (
            <line
              key={item.id}
              x1={x(item.start[0])}
              y1={z(item.start[1])}
              x2={x(item.end[0])}
              y2={z(item.end[1])}
              stroke="#006783"
              strokeWidth="2"
              markerEnd="url(#stair-arrow)"
            />
          ))}
        {elements
          .filter((item) => item.kind === "zone")
          .map((item) => {
            const center = item.polygon.reduce(
              ([a, b], [c, d]) => [
                a + c / item.polygon.length,
                b + d / item.polygon.length,
              ],
              [0, 0],
            );
            return (
              <text
                key={item.id}
                x={x(center[0])}
                y={z(center[1])}
                textAnchor="middle"
                fontSize="8"
                fill="#28352c"
              >
                {item.label}
              </text>
            );
          })}
        {walk?.pickStart &&
          area?.polygons.map((p, i) => (
            <path
              key={`free-${i}`}
              d={polygon(p.outer) + p.holes.map(polygon).join("")}
              fill="#31876c"
              fillOpacity="0.35"
              fillRule="evenodd"
              pointerEvents="none"
            />
          ))}
        {walk &&
          (() => {
            const route = walk.route;
            const start =
              walk.start?.point || route?.points[0]?.filter((_, i) => i !== 1);
            const target = route?.target_position || walk.targetPosition;
            const end = route?.points.at(-1);
            const point = route && pathPosition(route.points, walk.distance);
            const marker = (p, label, color) =>
              p && (
                <g key={label}>
                  <circle
                    cx={x(p[0])}
                    cy={z(p[1])}
                    r="4"
                    fill={color}
                    stroke="#172630"
                    strokeWidth="1"
                  />
                  <text
                    x={x(p[0]) + 6}
                    y={z(p[1]) - 5}
                    fontSize="9"
                    fill="#172630"
                    stroke="#fff"
                    strokeWidth="2"
                    paintOrder="stroke"
                  >
                    {label}
                  </text>
                </g>
              );
            return (
              <g pointerEvents="none">
                {route && (
                  <polyline
                    points={route.points
                      .map((p) => `${x(p[0])},${z(p[2])}`)
                      .join(" ")}
                    fill="none"
                    stroke="#006f9d"
                    strokeWidth="3"
                  />
                )}
                {end && target && (
                  <line
                    x1={x(end[0])}
                    y1={z(end[2])}
                    x2={x(target[0])}
                    y2={z(target[2])}
                    stroke="#956322"
                    strokeDasharray="3 2"
                  />
                )}
                {marker(
                  start,
                  "Start",
                  area && start && !insideWalkingArea(start, area.polygons)
                    ? "#ff967f"
                    : "#7de4bc",
                )}
                {marker(target && [target[0], target[2]], "Object", "#ffc878")}
                {marker(end && [end[0], end[2]], "Stop", "#0abeff")}
                {walk.distance > 0 &&
                  marker(point && [point[0], point[2]], "You", "#fff")}
              </g>
            );
          })()}
      </svg>
      <figcaption>
        {scene.architecture.levels.find((item) => item.id === level)?.name} plan
        · Estimated. Section at 1 m. Arrow: stairs up.
      </figcaption>
    </figure>
  );
}

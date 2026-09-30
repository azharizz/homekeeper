import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { post, request } from "./api";
import { CopyAction, PageList } from "./ui";
import { anchorReference, anchorWorld } from "./architecture/anchors";
import { FeaturePicker } from "./architecture/FeaturePicker";

export default function Measurements({ scene, points, onPoints }) {
  const [component, setComponent] = useState(
    Object.keys(scene.components).find(
      (id) => scene.components[id].anchor_matrix,
    ) || "",
  );
  const [anchor, setAnchor] = useState([0.5, 0.5, 0.5]);
  const [distance, setDistance] = useState("");
  const [uncertainty, setUncertainty] = useState("");
  const [provenance, setProvenance] = useState("");
  const [measurement, setMeasurement] = useState("");
  const [unit, setUnit] = useState("m");
  const [convention, setConvention] = useState("point_distance");
  const structure = useQuery({
    queryKey: ["structure", scene.id, scene.revision],
    queryFn: () => request(`/maps/${scene.id}/architecture/structure`),
  });
  const queries = useQueryClient();
  const saved = scene.architecture.measurements || [];
  const meters =
    points.length === 2
      ? Math.hypot(
          ...anchorWorld(scene, points[0]).map(
            (v, i) => v - anchorWorld(scene, points[1])[i],
          ),
        )
      : null;
  const add = useMutation({
    mutationFn: () =>
      post(`/maps/${scene.id}/architecture/measurements`, {
        expected_revision: scene.revision,
        measurement: {
          id: `m_${crypto.randomUUID().replaceAll("-", "")}`,
          label: `${points[0].note} to ${points[1].note}`.slice(0, 2000),
          start: anchorReference(points[0]),
          end: anchorReference(points[1]),
          distance_m: Number(distance) / (unit === "cm" ? 100 : 1),
          uncertainty_m: Number(uncertainty) / (unit === "cm" ? 100 : 1),
          provenance,
        },
      }),
    onSuccess: () => {
      queries.invalidateQueries();
      setDistance("");
      setUncertainty("");
      setProvenance("");
    },
  });
  const scale = useMutation({
    mutationFn: () =>
      post(`/maps/${scene.id}/architecture/scale-proposal`, {
        expected_revision: scene.revision,
        measurement_ids: [measurement],
      }),
  });
  const dimension = useMutation({
    mutationFn: () =>
      post(`/maps/${scene.id}/architecture/dimensions`, {
        expected_revision: scene.revision,
        dimension: {
          id: `d_${crypto.randomUUID().replaceAll("-", "")}`,
          label: `${points[0].note} to ${points[1].note}`.slice(0, 2000),
          start: anchorReference(points[0]),
          end: anchorReference(points[1]),
          convention,
        },
      }),
    onSuccess: () => queries.invalidateQueries(),
  });
  const display = (meters) =>
    `${(meters * (unit === "cm" ? 100 : 1)).toFixed(unit === "cm" ? 1 : 3)} ${unit}`;
  const apply = useMutation({
    mutationFn: () =>
      post(`/maps/${scene.id}/architecture`, {
        expected_revision: scale.data.revision,
        document: scale.data.document,
      }),
    onSuccess: () => {
      queries.invalidateQueries();
      scale.reset();
    },
  });
  return (
    <>
      <p className="hint">
        Pick two points on the model. Distances follow the current geometry.
      </p>
      <label>
        Display unit
        <select
          value={unit}
          onChange={(e) => {
            setUnit(e.target.value);
            setDistance("");
            setUncertainty("");
          }}
        >
          <option value="m">Metres (m)</option>
          <option value="cm">Centimetres (cm)</option>
        </select>
      </label>
      <ol>
        {points.map((p, i) => (
          <li key={i}>{p.note}</li>
        ))}
      </ol>
      {meters !== null && (
        <p className="measurement-value" role="status">
          {display(meters)} <small>Estimated point distance</small>
        </p>
      )}
      <button disabled={!points.length} onClick={() => onPoints([])}>
        Clear points
      </button>
      <FeaturePicker
        scene={scene}
        onChoose={(point) =>
          onPoints([...(points.length < 2 ? points : []), point])
        }
      />
      {points.length === 2 && (
        <details>
          <summary>Save model dimension</summary>
          <label>
            Measure between
            <select
              value={convention}
              onChange={(e) => setConvention(e.target.value)}
            >
              <option value="point_distance">Selected points</option>
              <option value="wall_faces">
                Opposing wall faces (clear distance)
              </option>
              <option value="wall_centerlines">Wall centerlines</option>
            </select>
          </label>
          <p className="hint">
            Wall dimensions require two parallel wall features. Clear distance
            uses the facing surfaces, including only the authored thickness.
          </p>
          <button
            disabled={dimension.isPending}
            onClick={() => dimension.mutate()}
          >
            {dimension.isPending ? "Saving…" : "Save dimension"}
          </button>
        </details>
      )}
      <PageList
        items={structure.data?.dimensions || []}
        label="Saved dimensions"
        empty=""
      >
        {(page) => (
          <ul className="issue-list">
            {page.map((d) => (
              <li key={d.id}>
                <strong>{display(d.distance_m)}</strong>
                <p>{d.label}</p>
                <small>{d.convention.replaceAll("_", " ")} · Estimated</small>
                <button
                  onClick={() =>
                    onPoints(
                      [d.start, d.end].map((point, i) => ({
                        ...point,
                        world: d.world_points[i],
                        note: d.label,
                      })),
                    )
                  }
                >
                  Show endpoints
                </button>
              </li>
            ))}
          </ul>
        )}
      </PageList>
      <details>
        <summary>Choose a point by coordinates</summary>
        <label>
          Component
          <select
            value={component}
            onChange={(e) => setComponent(e.target.value)}
          >
            {scene.architecture.elements
              .filter((e) => scene.components[e.id]?.anchor_matrix)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
          </select>
        </label>
        <p className="hint">
          Local bounds: 0 is the lower edge, 1 is the upper edge.
        </p>
        <div className="placement-fields">
          {["X", "Y", "Z"].map((axis, i) => (
            <label key={axis}>
              {axis}
              <input
                type="number"
                min="0"
                max="1"
                step="any"
                value={anchor[i]}
                onChange={(e) =>
                  setAnchor((old) =>
                    old.map((v, j) => (j === i ? Number(e.target.value) : v)),
                  )
                }
              />
            </label>
          ))}
        </div>
        <button
          disabled={
            !component ||
            anchor.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
          }
          onClick={() =>
            onPoints([
              ...(points.length < 2 ? points : []),
              {
                element_id: component,
                anchor: [...anchor],
                note: scene.architecture.elements.find(
                  (e) => e.id === component,
                ).label,
              },
            ])
          }
        >
          Use this point
        </button>
      </details>
      <details>
        <summary>Enter a real measurement</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <fieldset disabled={points.length !== 2 || add.isPending}>
            <label>
              Measured distance ({unit})
              <input
                type="number"
                min="0.001"
                max="10000"
                step="any"
                required
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
              />
            </label>
            <label>
              Measurement uncertainty ({unit})
              <input
                type="number"
                min="0.001"
                max="10000"
                step="any"
                required
                value={uncertainty}
                onChange={(e) => setUncertainty(e.target.value)}
              />
            </label>
            <label>
              How and when measured
              <input
                required
                maxLength={2000}
                value={provenance}
                onChange={(e) => setProvenance(e.target.value)}
                placeholder="Instrument, endpoints and date"
              />
            </label>
            <button type="submit">
              {add.isPending ? "Saving…" : "Save measurement"}
            </button>
          </fieldset>
        </form>
        {add.isSuccess && (
          <p role="status">Measurement saved. Geometry has not changed.</p>
        )}
      </details>
      {saved.length > 0 && (
        <details>
          <summary>Adjust scale from a measurement</summary>
          <label>
            Physical measurement
            <select
              value={measurement}
              onChange={(e) => {
                setMeasurement(e.target.value);
                scale.reset();
              }}
            >
              <option value="">Choose a measurement</option>
              {saved.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.label}: {m.distance_m} m
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!measurement || scale.isPending}
            onClick={() => scale.mutate()}
          >
            {scale.isPending ? "Calculating…" : "Preview scale"}
          </button>
          {scale.data && (
            <>
              <p role="status">
                Scale all model dimensions by{" "}
                {scale.data.scale_factor.toFixed(5)}. Other dimensions remain
                estimates.
              </p>
              <p className="hint">
                {
                  scale.data.after.filter((m) => !m.within_reported_uncertainty)
                    .length
                }{" "}
                reported distances remain outside their uncertainty.
              </p>
              <button
                disabled={
                  apply.isPending || scale.data.revision !== scene.revision
                }
                onClick={() => apply.mutate()}
              >
                Apply to a new revision
              </button>
            </>
          )}
        </details>
      )}
      {[add.error, scale.error, apply.error, dimension.error, structure.error]
        .filter(Boolean)
        .map((error, i) => (
          <p key={i} role="alert" className="error">
            {error.message}
          </p>
        ))}
      <CopyAction
        label="Copy correction request"
        text={`Inspect RoomTrace capture ${scene.id}, its current architecture and every reference photo. Add corresponding fit and excluded check observations across multiple views. Use refine_architecture with explicit bounded parameters and fixed geometry to anchor the frame. Inspect architecture_photo_overlay before and after, observability and geometric checks. Publish only a supported improvement using the current revision. Physical distances must come from reported measurements, never furniture labels.`}
      />
    </>
  );
}

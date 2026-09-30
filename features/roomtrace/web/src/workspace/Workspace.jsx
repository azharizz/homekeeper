import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import MapView, { Projection } from "../MapView";
import ArchitectureView from "../ArchitectureView";
import ModelingRequest from "../architecture/ModelingRequest";
import { artifact, post, request } from "../api";
import { ErrorMessage, Icon } from "../ui";
import Observation from "../Observation";

const number = (value) => new Intl.NumberFormat().format(value);

function ScaleForm({ scene, points, setPoints }) {
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data) => post(`/maps/${scene.id}/scale`, data),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["scene", scene.id] }),
  });
  return (
    <details className="scale-form">
      <summary>Set a measured distance</summary>
      <p className="hint">
        Turn off Surface and select two points in 3D, or enter their point
        indices. Measure that distance in the actual room. This sets scale, not
        floor alignment.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({
            point_a: points[0],
            point_b: points[1],
            distance_m: Number(new FormData(e.currentTarget).get("distance")),
          });
        }}
      >
        <div className="split">
          {["Point A", "Point B"].map((label, i) => (
            <label key={label}>
              {label}
              <input
                type="number"
                min="0"
                max={scene.points.length - 1}
                required
                value={points[i] ?? ""}
                onChange={(e) => {
                  const next = [...points];
                  next[i] = Number(e.target.value);
                  setPoints(next);
                }}
              />
            </label>
          ))}
        </div>
        <label>
          Distance in meters
          <input
            name="distance"
            type="number"
            min="0.001"
            max="1000"
            step="any"
            required
          />
        </label>
        <button disabled={mutation.isPending || points.length !== 2}>
          Save distance
        </button>
        <ErrorMessage error={mutation.error} />
        {mutation.isSuccess && <p role="status">Distance calibration saved.</p>}
      </form>
    </details>
  );
}

export default function Workspace({ job }) {
  const cache = useQueryClient();
  const [observation, setObservation] = useState(null);
  const [points, setPoints] = useState([]);
  const [tool, setTool] = useState("");
  const toolButtons = useRef({});
  const closeTool = () => {
    toolButtons.current[tool]?.focus();
    setTool("");
  };
  const sceneQuery = useQuery({
    queryKey: ["scene", job.id, job.revision],
    queryFn: () => request(`/maps/${job.id}/scene`),
    enabled: job.status === "ready",
    placeholderData: (previous) => previous,
  });
  const retry = useMutation({
    mutationFn: () => post(`/maps/${job.id}/retry`, {}),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["maps"] }),
  });
  const scene = sceneQuery.data;
  if (!scene)
    return (
      <section className="job-state">
        <Icon name="cube" size={36} />
        <h1>{job.name}</h1>
        <p role="status">
          {job.status === "ready" ? "Opening your model…" : job.stage}
        </p>
        {job.status === "running" && <progress aria-label={job.stage} />}
        {job.status === "awaiting_agent" && <ModelingRequest job={job} />}
        <p className="error">{job.error}</p>
        <ErrorMessage error={sceneQuery.error || retry.error} />
        {["failed", "interrupted"].includes(job.status) && (
          <button onClick={() => retry.mutate()} disabled={retry.isPending}>
            Retry reconstruction
          </button>
        )}
        <p className="hint">Saved on your server. You can leave and return.</p>
      </section>
    );
  if (scene.mode === "architecture")
    return (
      <ArchitectureView
        key={`${scene.id}:${scene.revision}`}
        scene={scene}
        observation={observation}
      >
        <Observation
          key={`${scene.id}:${scene.revision}`}
          scene={scene}
          onObservation={setObservation}
        />
      </ArchitectureView>
    );
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>{scene.name}</h1>
          <p className="hint">
            {scene.mode === "multiview"
              ? "Feature reconstruction"
              : "Photo mesh"}{" "}
            · {scene.scale ? "Distance calibrated" : "Scale unverified"}
          </p>
        </div>
        <div className="downloads">
          {scene.artifacts.map((name) => (
            <a key={name} href={artifact(job.id, name)} download>
              <Icon name="download" size={16} />{" "}
              {name.endsWith("glb") ? "GLB" : "PLY"}
            </a>
          ))}
        </div>
      </div>
      <div className="workspace-actions">
        <button
          ref={(node) => {
            toolButtons.current.details = node;
          }}
          aria-pressed={tool === "details"}
          onClick={() => setTool(tool === "details" ? "" : "details")}
        >
          <Icon name="info" /> Details
        </button>
        <button
          ref={(node) => {
            toolButtons.current.camera = node;
          }}
          aria-pressed={tool === "camera"}
          onClick={() => setTool(tool === "camera" ? "" : "camera")}
        >
          <Icon name="camera" /> Camera
        </button>
      </div>
      <div className={`model-layout ${tool ? "has-panel" : ""}`}>
        <div className="spatial-column">
          <MapView
            scene={scene}
            observation={observation}
            selectedPoints={points.filter(
              (i) => Number.isInteger(i) && i >= 0 && i < scene.points.length,
            )}
            onPick={(index) =>
              setPoints((current) =>
                current.length < 2 ? [...current, index] : [index],
              )
            }
          />
          <details className="plan-overview" open>
            <summary>Map overview</summary>
            <Projection scene={scene} observation={observation} />
          </details>
        </div>
        {tool === "details" && (
          <section
            className="inspector"
            aria-label="Map details"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeTool();
            }}
          >
            <div className="panel-heading">
              <h2>Map details</h2>
              <button
                className="icon-button"
                aria-label="Close details"
                onClick={closeTool}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="evidence">
              <dl>
                <div>
                  <dt>
                    {scene.mode === "multiview"
                      ? "Registered views"
                      : "Modeled views"}
                  </dt>
                  <dd>
                    {scene.registered_frames} / {scene.total_frames}
                  </dd>
                </div>
                <div>
                  <dt>3D landmarks</dt>
                  <dd>{number(scene.sparse_points)}</dd>
                </div>
                <div>
                  <dt>Surface triangles</dt>
                  <dd>{number(scene.surface_triangles)}</dd>
                </div>
                <div>
                  <dt>Reprojection error</dt>
                  <dd>
                    {scene.reprojection_error_px === null
                      ? "Not measured"
                      : `${scene.reprojection_error_px.toFixed(2)} px`}
                  </dd>
                </div>
                <div>
                  <dt>Scale</dt>
                  <dd>
                    {scene.scale
                      ? "User-measured distance"
                      : scene.scale_provenance}
                  </dd>
                </div>
              </dl>
              <p className="hint">
                {scene.geometry_source}. {scene.pose_source}{" "}
                {scene.quality_status}
              </p>
              <p className="hint">
                Unobserved areas remain empty. The projection is not a surveyed
                floor plan.
              </p>
              <ScaleForm scene={scene} points={points} setPoints={setPoints} />
            </div>
          </section>
        )}
        {tool === "camera" && (
          <section
            className="inspector"
            aria-label="Camera comparison"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeTool();
            }}
          >
            <div className="panel-heading">
              <h2>Camera</h2>
              <button
                className="icon-button"
                aria-label="Close camera"
                onClick={closeTool}
              >
                <Icon name="close" />
              </button>
            </div>
            <Observation
              key={scene.id}
              scene={scene}
              onObservation={setObservation}
            />
          </section>
        )}
      </div>
    </>
  );
}

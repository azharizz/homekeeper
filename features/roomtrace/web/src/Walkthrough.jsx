import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "./api";
import { stepProgress } from "./walkthrough-math";

export default function Walkthrough({
  scene,
  level,
  objects,
  walk,
  onChange,
  stepLength,
  onStepLength,
  area,
  areaPending,
  areaError,
  validStart,
}) {
  const floors = scene.architecture.elements
    .filter((e) => e.kind === "slab" && e.level === level)
    .sort((a, b) => a.top - b.top);
  const [stepInput, setStepInput] = useState(
    String(Math.round(stepLength * 100)),
  );
  const profile = walk.profile;
  const floor = walk.start?.floor_id || walk.floor || floors[0]?.id;
  const destinations = objects.filter(
    (e) =>
      ["box", "solid", "asset", "rail"].includes(e.kind) && e.level === level,
  );
  const route = walk.route;
  const steps = route
    ? stepProgress(walk.distance, route.distance_m, stepLength)
    : null;
  const preview = useMutation({
    mutationFn: (values) =>
      post(`/maps/${scene.id}/architecture/walkthrough`, values),
    onSuccess: (data) =>
      onChange({
        route: data,
        target: data.target_id,
        distance: 0,
        mode: "overview",
        playing: false,
        look: 0,
        error: null,
      }),
    onError: (error) => onChange({ error: error.message }),
    onSettled: () => onChange({ pending: false }),
  });
  const clear = (patch) => {
    preview.reset();
    onChange({
      ...patch,
      route: null,
      error: null,
      playing: false,
      mode: "overview",
    });
  };
  return (
    <section className="walkthrough-panel" aria-label="Guided walkthrough">
      {!route && (
        <p className="hint">
          Pick your start on the highlighted floor, then choose an object.
        </p>
      )}
      <details className="walkthrough-settings" open={!route}>
        <summary>
          {route
            ? `${route.target_label.replaceAll("_", " ")} · ${Math.round(stepLength * 100)} cm steps`
            : "Destination & step settings"}
        </summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ pending: true, playing: false, error: null });
            preview.mutate({
              expected_revision: scene.revision,
              floor_id: floor,
              target_id: walk.target,
              start: walk.start.point,
              ...profile,
            });
          }}
        >
          <fieldset disabled={walk.pending}>
            <label>
              Go to
              <select
                required
                value={walk.target}
                onChange={(e) => clear({ target: e.target.value })}
              >
                <option value="">Choose an object</option>
                {destinations.map((e) => (
                  <option key={e.id} value={e.id}>
                    {(e.assembly || e.label).replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <div className="walkthrough-start">
              <span>
                {walk.start
                  ? validStart
                    ? "Start placed on the floor"
                    : "Start needs more clearance"
                  : "Choose your starting point"}
              </span>
              <button
                type="button"
                aria-pressed={walk.pickStart}
                onClick={() => clear({ pickStart: !walk.pickStart })}
              >
                {walk.pickStart
                  ? "Cancel pick"
                  : walk.start
                    ? "Change start"
                    : "Pick start"}
              </button>
            </div>
            {walk.pickStart && (
              <p role="status">
                Click the highlighted area in the model or floor plan. Dragging
                only changes the view. The floor plan also supports arrow keys
                and Enter.
              </p>
            )}
            {areaPending && <p role="status">Checking floor clearance…</p>}
            {areaError && (
              <p role="alert" className="error">
                {areaError.message}
              </p>
            )}
            {walk.start && area && !validStart && (
              <p role="alert" className="error">
                The selected point does not fit the current body width. Pick
                inside the highlighted area. Your point has not been moved.
              </p>
            )}
            <label>
              Estimated step length
              <div className="walkthrough-step">
                <input
                  aria-label="Estimated step length in centimetres"
                  type="number"
                  min="10"
                  max="150"
                  step="1"
                  required
                  value={stepInput}
                  onBlur={() =>
                    setStepInput(String(Math.round(stepLength * 100)))
                  }
                  onChange={(e) => {
                    setStepInput(e.target.value);
                    if (e.target.validity.valid && e.target.value) {
                      onStepLength(Number(e.target.value) / 100);
                      onChange({ playing: false });
                    }
                  }}
                />
                <span>cm per step</span>
              </div>
            </label>
            <details>
              <summary>Body & clearance</summary>
              <label>
                Floor surface
                <select
                  value={floor || ""}
                  onChange={(e) => {
                    clear({
                      floor: e.target.value,
                      start: null,
                      pickStart: true,
                    });
                  }}
                >
                  {floors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              {Object.entries({
                radius_m: "Body radius (m)",
                body_height_m: "Body height (m)",
                eye_height_m: "Eye height (m)",
                stop_distance_m: "Minimum gap from object (m)",
              }).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    required
                    min={
                      key === "radius_m" || key === "stop_distance_m"
                        ? 0.1
                        : key === "eye_height_m"
                          ? 0.3
                          : 0.5
                    }
                    max={
                      key === "radius_m"
                        ? 1
                        : key === "stop_distance_m"
                          ? 3
                          : key === "eye_height_m"
                            ? 2.4
                            : 2.5
                    }
                    step="0.01"
                    value={profile[key]}
                    onChange={(e) => {
                      clear({
                        profile: { ...profile, [key]: Number(e.target.value) },
                      });
                    }}
                  />
                </label>
              ))}
              <p className="hint">
                Defaults are illustrative. Horizontal floors only; stairs and
                unassessed zones are excluded.
              </p>
            </details>
            <button
              className="primary"
              type="submit"
              disabled={
                !floor ||
                !walk.target ||
                !walk.start ||
                !validStart ||
                areaPending ||
                !!areaError ||
                walk.pending
              }
            >
              {walk.pending
                ? "Finding a model route…"
                : route
                  ? "Recalculate route"
                  : "Preview route"}
            </button>
          </fieldset>
        </form>
      </details>
      {walk.error && (
        <p role="alert" className="error">
          {walk.error}
        </p>
      )}
      {route && (
        <div className="walkthrough-result">
          <p className="measurement-value">
            {route.distance_m.toFixed(2)} m{" "}
            <small>
              About {steps.steps} steps to{" "}
              {route.target_label.replaceAll("_", " ")}
            </small>
          </p>
          <p className="hint">
            The blue Stop marker is {route.approach_gap_m.toFixed(2)} m from the
            object. The amber line points to the object and is not part of the
            walk.
          </p>
          <div className="walkthrough-buttons">
            <button type="button" onClick={() => clear({ pickStart: true })}>
              Change start
            </button>
            <button
              type="button"
              onClick={() =>
                onChange({
                  mode:
                    walk.mode === "firstPerson" ? "overview" : "firstPerson",
                  playing: false,
                  look: 0,
                })
              }
            >
              {walk.mode === "firstPerson"
                ? "Show overview"
                : "Enter walkthrough"}
            </button>
            <button
              type="button"
              disabled={walk.distance >= route.distance_m}
              onClick={() =>
                onChange({
                  mode: "firstPerson",
                  playing: !walk.playing,
                  look: 0,
                })
              }
            >
              {walk.playing ? "Pause" : "Play walk"}
            </button>
            <button
              type="button"
              disabled={walk.distance >= route.distance_m}
              onClick={() =>
                onChange({
                  distance: steps.next,
                  mode: "firstPerson",
                  playing: false,
                  look: 0,
                })
              }
            >
              Next step
            </button>
            <button
              type="button"
              onClick={() => onChange({ distance: 0, playing: false, look: 0 })}
            >
              Restart
            </button>
          </div>
          <label>
            Walk progress
            <input
              type="range"
              min="0"
              max={route.distance_m}
              step="any"
              value={walk.distance}
              onChange={(e) =>
                onChange({
                  distance: Number(e.target.value),
                  playing: false,
                  look: 0,
                })
              }
            />
          </label>
          <p className="walkthrough-progress">
            {walk.distance >= route.distance_m
              ? "At the preview destination"
              : `Step ${steps.completed} of about ${steps.steps}`}{" "}
            · {walk.distance.toFixed(2)} / {route.distance_m.toFixed(2)} m
          </p>
          <span className="sr-only" role="status">
            {walk.distance >= route.distance_m
              ? "At the preview destination"
              : `Step ${steps.completed} of about ${steps.steps}`}
          </span>
          {walk.mode === "firstPerson" && (
            <label>
              Look around
              <input
                type="range"
                min={-180}
                max={180}
                step="1"
                value={Math.round(((walk.look || 0) * 180) / Math.PI)}
                onChange={(e) =>
                  onChange({
                    look: (Number(e.target.value) * Math.PI) / 180,
                    playing: false,
                  })
                }
              />
            </label>
          )}
          <p className="hint">
            Final step may be shorter. Playback moves one estimated step per
            second.
          </p>
        </div>
      )}
      <p className="hint">
        Model preview only. Dimensions and steps are estimates. Your physical
        position is unknown; this is not a verified walking aid.
      </p>
    </section>
  );
}

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Camera from "./Camera";
import { apiUrl, post, request } from "./api";
import { CopyAction, ErrorMessage, Icon } from "./ui";

export default function Observation({ scene, onObservation }) {
  const [calibration, setCalibration] = useState("");
  const [result, setResult] = useState(null);
  const generation = useRef(0);
  const queries = useQueryClient();
  const index = useMutation({
    mutationFn: () =>
      post(`/maps/${scene.id}/architecture/landmarks`, {
        expected_revision: scene.revision,
      }),
    onSuccess: () => queries.invalidateQueries(),
  });
  const localization = useMutation({
    mutationFn: (data) =>
      request(`/maps/${scene.id}/localize`, { method: "POST", body: data }),
  });
  const busy = localization.isPending;
  const canObserve = scene.localizable || scene.mode === "architecture";
  const capture = async (
    file,
    timestamp,
    current = () => true,
    started = performance.now(),
  ) => {
    const attempt = ++generation.current;
    onObservation(null);
    setResult(null);
    const data = new FormData();
    data.append("image", file, file.name || "observation.jpg");
    if (calibration.trim()) data.append("calibration", calibration);
    if (timestamp) data.append("captured_at", timestamp);
    const value = await localization.mutateAsync(data);
    if (!current() || attempt !== generation.current) return;
    setResult({ ...value, round_trip_ms: performance.now() - started });
    onObservation(value);
  };
  return (
    <section className="observation">
      <p className="hint">
        {scene.mode === "architecture" && !scene.localizable
          ? "Save a view for Codex to compare. Position is not available for this draft."
          : "Match a new view to the map's landmarks."}
      </p>
      <Camera
        continuous={scene.localizable}
        onFrame={capture}
        onStop={() => {
          generation.current += 1;
          onObservation(null);
          setResult(null);
        }}
        disabled={!canObserve || busy}
      />
      {scene.mode === "architecture" && (
        <details>
          <summary>Map landmarks · {scene.landmark_count || 0}</summary>
          <p className="hint">
            Shared photo landmarks connect new camera views to this model. New
            revisions need a new index.
          </p>
          <button disabled={index.isPending} onClick={() => index.mutate()}>
            {index.isPending ? "Building…" : "Build observed landmarks"}
          </button>
          <ErrorMessage error={index.error} />
          {scene.localizable && (
            <a
              href={apiUrl(`/maps/${scene.id}/architecture/guidance`)}
              download
            >
              Compact map (.json)
            </a>
          )}
          <CopyAction
            label="Copy landmark request"
            text={`Inspect RoomTrace ${scene.id} and every reference image. Establish at least eight distinctive shared photo fit landmarks across two or more views with depth variation, and separate check points. Use photo overlays and refinement to resolve discrepancies before build_architecture_landmarks. Never turn check landmarks into fitting data just to pass. Do not invent correspondences.`}
          />
        </details>
      )}
      <label
        className={`upload-inline ${!canObserve || busy ? "disabled" : ""}`}
      >
        <Icon name="photo" />
        {busy ? "Processing image…" : "Choose an image"}
        <input
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={!canObserve || busy}
          onChange={async (event) => {
            const file = event.target.files[0];
            event.target.value = "";
            if (!file) return;
            try {
              await capture(file, null);
            } catch {
              /* Request error is displayed below. */
            }
          }}
        />
      </label>
      <ErrorMessage error={localization.error} />
      {result && (
        <div className="observation-result" role="status">
          <strong>
            {result.status === "localized"
              ? "Last view matched to model"
              : scene.mode === "architecture"
                ? "View saved for review"
                : "Position unknown"}
          </strong>
          <p className="hint">
            {result.status === "localized"
              ? `${result.inliers} landmarks · ${result.reprojection_error_px.toFixed(2)} px error`
              : result.reason}
          </p>
          {result.model_position_m && (
            <p>
              Model position:{" "}
              {result.model_position_m
                .map((n) => `${n.toFixed(2)} m`)
                .join(", ")}{" "}
              (X, Y, Z). Physical accuracy unverified.
            </p>
          )}
          <details>
            <summary>Observation details</summary>
            <p className="hint">
              {(result.round_trip_ms / 1000).toFixed(2)} s capture to result ·{" "}
              {(result.latency_ms / 1000).toFixed(2)} s pose processing ·{" "}
              {new Date(result.completed_at * 1000).toLocaleTimeString()}
            </p>
            {result.reference && (
              <img
                src={apiUrl(`/maps/${scene.id}/images/${result.reference}`)}
                alt="Matched source view"
              />
            )}
          </details>
        </div>
      )}
      <CopyAction
        key={result?.query_id || scene.id}
        text={`Inspect RoomTrace map ${scene.id}${result ? ` and observation ${result.query_id}` : ""} using MCP. Compare the source images and geometry, and report what is supported or missing.`}
        label="Copy review request"
      />
      <p className="hint">Paste in Codex. Answers appear there.</p>
      <details>
        <summary>Camera calibration</summary>
        <textarea
          rows={3}
          value={calibration}
          onChange={(e) => setCalibration(e.target.value)}
          aria-label="Observation camera calibration JSON"
          placeholder="Optional camera JSON"
        />
      </details>
    </section>
  );
}

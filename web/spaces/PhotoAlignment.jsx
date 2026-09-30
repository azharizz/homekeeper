import { Suspense, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import { Matrix4, Quaternion, Vector3 } from "three";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUrl, post } from "./api";
import { Icon, PageList } from "./ui";
import { FeaturePicker } from "./architecture/FeaturePicker";
import { anchorReference } from "./architecture/anchors";

function MatchedCamera({ fit }) {
  const matrix = new Matrix4().set(...fit.camera_to_world.flat());
  const position = new Vector3(),
    rotation = new Quaternion();
  matrix.decompose(position, rotation, new Vector3());
  const k = fit.intrinsic;
  const near = 0.01;
  const projection = k
    ? new Matrix4().makePerspective(
        (-k[0][2] / k[0][0]) * near,
        ((fit.size[0] - k[0][2]) / k[0][0]) * near,
        (k[1][2] / k[1][1]) * near,
        (-(fit.size[1] - k[1][2]) / k[1][1]) * near,
        near,
        10000,
      )
    : undefined;
  return (
    <PerspectiveCamera
      makeDefault
      manual
      aspect={fit.size[0] / fit.size[1]}
      position={position}
      quaternion={rotation}
      fov={fit.fov_y}
      near={0.01}
      far={10000}
      {...(projection
        ? {
            projectionMatrix: projection,
            projectionMatrixInverse: projection.clone().invert(),
          }
        : {})}
    />
  );
}

export default function PhotoAlignment({
  scene,
  photo,
  picked,
  renderModel,
  draft,
  onDraftChange,
}) {
  const initial =
    draft || scene.architecture.alignments?.find((a) => a.source === photo);
  const frame = scene.frames.find((f) => f.name === photo);
  const [matches, setMatches] = useState(initial?.matches || []);
  const [fov, setFov] = useState(initial?.fov_y || 60);
  const [opacity, setOpacity] = useState(0.5);
  const [dirty, setDirty] = useState(Boolean(draft));
  const [landmark, setLandmark] = useState(0);
  const [selectedFeature, setSelectedFeature] = useState(null);
  const selected = selectedFeature || picked;
  const active = Math.min(landmark, Math.max(0, matches.length - 1));
  const queries = useQueryClient();
  const requestFit = useMutation({
    mutationFn: (save) =>
      post(`/maps/${scene.id}/architecture/alignment`, {
        expected_revision: scene.revision,
        alignment: {
          source: photo,
          fov_y: fov,
          matches,
          calibration: initial?.calibration || null,
        },
        save,
      }),
    onSuccess: (result) => {
      if (result.saved) queries.invalidateQueries();
    },
  });
  const fit =
    requestFit.data?.fit ||
    (!dirty && scene.photo_alignments?.find((a) => a.source === photo));
  const change = (next) => {
    setMatches(next);
    onDraftChange({
      matches: next,
      fov_y: fov,
      calibration: initial?.calibration || null,
    });
    setDirty(true);
    requestFit.reset();
  };
  const edit = (index, field, value) =>
    change(matches.map((m, i) => (i === index ? { ...m, [field]: value } : m)));
  const picture = apiUrl(`/maps/${scene.id}/images/${photo}`);
  const fittingCount = matches.filter((m) => m.role !== "check").length;
  return (
    <>
      <div
        className="alignment-picture"
        style={{ aspectRatio: `${frame.size[0]} / ${frame.size[1]}` }}
      >
        {fit && !fit.distortion?.some((n) => n !== 0) && (
          <Canvas
            frameloop="demand"
            key={JSON.stringify(fit.camera_to_world)}
            dpr={[1, 1.5]}
          >
            <color attach="background" args={["#172630"]} />
            <ambientLight intensity={0.9} />
            <hemisphereLight args={["#fff9ef", "#687983", 1.7]} />
            <directionalLight position={[8, 16, -6]} intensity={2} />
            <Suspense fallback={null}>{renderModel()}</Suspense>
            <MatchedCamera fit={fit} />
          </Canvas>
        )}
        <button
          type="button"
          className="alignment-photo-button"
          aria-label="Add photo point for selected model landmark"
          disabled={!selected || matches.length >= 64 || requestFit.isPending}
          onClick={(event) => {
            if (!event.detail) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setLandmark(matches.length);
            change([
              ...matches,
              {
                ...anchorReference(selected),
                note: selected.note,
                image: [
                  (event.clientX - rect.left) / rect.width,
                  (event.clientY - rect.top) / rect.height,
                ],
              },
            ]);
          }}
        >
          <img
            src={picture}
            alt="Full source photograph for landmark matching"
            style={{ opacity: fit ? opacity : 1 }}
          />
        </button>
        <svg
          className="alignment-markers"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {matches.map((m, i) => (
            <g key={i}>
              {fit && (
                <>
                  <line
                    x1={m.image[0] * 1000}
                    y1={m.image[1] * 1000}
                    x2={fit.matches[i].projected[0] * 1000}
                    y2={fit.matches[i].projected[1] * 1000}
                    stroke="#f5a65b"
                    strokeWidth="3"
                  />
                  <circle
                    cx={fit.matches[i].projected[0] * 1000}
                    cy={fit.matches[i].projected[1] * 1000}
                    r="6"
                    fill="#f5a65b"
                  />
                </>
              )}
              <circle
                cx={m.image[0] * 1000}
                cy={m.image[1] * 1000}
                r="8"
                fill={m.role === "check" ? "#7057a3" : "#006783"}
                stroke="white"
                strokeWidth="2"
              />
              <text
                x={m.image[0] * 1000 + 12}
                y={m.image[1] * 1000 - 12}
                fontSize="26"
                fill="white"
                stroke="#006783"
                strokeWidth="0.6"
              >
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="hint">
        Select a model landmark, then the same point in the photo. Use at least
        six fitting points. Add separate check points before fitting to reveal
        mismatches the camera fit cannot optimize away.
      </p>
      <FeaturePicker scene={scene} onChoose={setSelectedFeature} />
      {selectedFeature && (
        <button onClick={() => setSelectedFeature(null)}>
          Use model pick instead
        </button>
      )}
      {selected && (
        <p className="hint" role="status">
          Selected: {selected.note}
        </p>
      )}
      <details>
        <summary>Edit landmarks · {matches.length}</summary>
        <fieldset className="alignment-inputs" disabled={requestFit.isPending}>
          <label>
            Vertical field of view (degrees)
            <input
              type="number"
              min="10"
              max="150"
              step="any"
              value={fov}
              disabled={Boolean(initial?.calibration)}
              onChange={(e) => {
                setFov(Number(e.target.value));
                onDraftChange({
                  matches,
                  fov_y: Number(e.target.value),
                  calibration: initial?.calibration || null,
                });
                setDirty(true);
                requestFit.reset();
              }}
            />
          </label>
          <p className="hint">
            Values run from 0 to 1. Photo U/V starts at top left; model X/Y/Z
            follows the component's local bounds.
          </p>
          {matches.length > 1 && (
            <nav className="pagination" aria-label="Landmark pages">
              <button
                type="button"
                disabled={!active}
                onClick={() => setLandmark(active - 1)}
              >
                <Icon name="back" size={16} /> Previous
              </button>
              <span aria-live="polite">
                {active + 1} / {matches.length}
              </span>
              <button
                type="button"
                disabled={active === matches.length - 1}
                onClick={() => setLandmark(active + 1)}
              >
                Next <Icon name="arrow" size={16} />
              </button>
            </nav>
          )}
          {matches.slice(active, active + 1).map((m) => {
            const i = active;
            return (
              <fieldset key={i} className="alignment-landmark">
                <legend>Landmark {i + 1}</legend>
                <label>
                  Use this point for
                  <select
                    value={m.role || "fit"}
                    onChange={(e) => edit(i, "role", e.target.value)}
                  >
                    <option value="fit">Camera fitting</option>
                    <option value="check">Checking only</option>
                  </select>
                </label>
                <label>
                  Component
                  <select
                    value={m.element_id}
                    disabled={Boolean(m.feature)}
                    onChange={(e) => edit(i, "element_id", e.target.value)}
                  >
                    {scene.architecture.elements
                      .filter(
                        (item) => scene.components[item.id]?.anchor_matrix,
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="placement-fields">
                  {["U", "V"].map((label, j) => (
                    <label key={label}>
                      Photo {label}
                      <input
                        aria-label={`Landmark ${i + 1} photo ${label}`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.001"
                        value={m.image[j]}
                        onChange={(e) =>
                          edit(
                            i,
                            "image",
                            m.image.map((n, k) =>
                              k === j ? Number(e.target.value) : n,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                {m.feature && <p>Exact feature: {m.feature.id}</p>}
                <div className="placement-fields">
                  {(m.anchor ? ["X", "Y", "Z"] : []).map((label, j) => (
                    <label key={label}>
                      Model {label}
                      <input
                        aria-label={`Landmark ${i + 1} model ${label}`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.001"
                        value={m.anchor[j]}
                        onChange={(e) =>
                          edit(
                            i,
                            "anchor",
                            m.anchor.map((n, k) =>
                              k === j ? Number(e.target.value) : n,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                <label>
                  Visible feature
                  <input
                    value={m.note}
                    maxLength={2000}
                    onChange={(e) => edit(i, "note", e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => change(matches.filter((_, j) => j !== i))}
                >
                  Remove landmark {i + 1}
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            disabled={
              matches.length >= 64 ||
              !Object.values(scene.components).some(
                (item) => item.anchor_matrix,
              )
            }
            onClick={() => {
              const first = scene.architecture.elements.find(
                (item) => scene.components[item.id]?.anchor_matrix,
              );
              setLandmark(matches.length);
              change([
                ...matches,
                {
                  element_id: first.id,
                  anchor: [0, 0, 0],
                  image: [0, 0],
                  note: "Describe the matching visible feature",
                },
              ]);
            }}
          >
            Add landmark manually
          </button>
        </fieldset>
      </details>
      <div className="alignment-actions">
        <button
          disabled={fittingCount < 6 || requestFit.isPending}
          onClick={() => requestFit.mutate(false)}
        >
          Fit camera
        </button>
        <button
          disabled={!fit || requestFit.isPending}
          onClick={() => requestFit.mutate(true)}
        >
          Save alignment
        </button>
      </div>
      {requestFit.isPending && (
        <p role="status">Fitting the supplied landmarks…</p>
      )}
      {requestFit.error && (
        <p role="alert" className="error">
          {requestFit.error.message}
        </p>
      )}
      {fit && (
        <>
          <label>
            Photo opacity
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>
          <p role="status">
            Fit RMS {fit.rmse_px.toFixed(1)} px · Maximum{" "}
            {fit.max_error_px.toFixed(1)} px
            {fit.planar ? " · Planar landmarks: pose ambiguity remains" : ""}
          </p>
          <p role="status">
            {fit.check_count
              ? `${fit.check_count} excluded check points: RMS ${fit.check_rmse_px.toFixed(1)} px · Maximum ${fit.check_max_error_px.toFixed(1)} px`
              : "No excluded check points. This score describes fitting only."}
          </p>
          <details>
            <summary>Landmark residuals</summary>
            <PageList items={fit.matches} label="Residuals">
              {(page) => (
                <ul className="residual-list">
                  {page.map((m, i) => (
                    <li key={i}>
                      {m.role === "check" ? "Check" : "Fit"}: {m.note}:{" "}
                      {m.error_px.toFixed(1)} px
                    </li>
                  ))}
                </ul>
              )}
            </PageList>
          </details>
        </>
      )}
      <p className="hint">
        Orange projections show mismatch. This estimated camera fit does not
        establish physical location.
      </p>
      {fit?.distortion?.some((n) => n !== 0) && (
        <p className="hint">
          Calibrated distortion is applied to landmark projections. The
          undistorted 3D overlay is hidden.
        </p>
      )}
      <a href={picture} target="_blank" rel="noreferrer">
        Open original photograph
      </a>
    </>
  );
}

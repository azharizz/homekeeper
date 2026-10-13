import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { request } from "./api";
import { FilePreview, Icon } from "./ui";
import { captureProblem, fileKey, mergeFiles } from "./capture";

const accept =
  "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/x-msvideo,.m4v";


function ReferenceView({ files, side }) {
  const [source, setSource] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [endpoint, setEndpoint] = useState(0);
  const [pixels, setPixels] = useState([["", ""], ["", ""]]);
  const file = files.find((item) => fileKey(item) === source);
  if (selectedFile !== file) {
    setSelectedFile(file);
    setPixels([["", ""], ["", ""]]);
  }
  const attachPhoto = useCallback((node) => {
    if (!node || !file) return;
    const url = URL.createObjectURL(file);
    node.src = url;
    return () => {
      node.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <div>
      <label>Reference photo {side + 1}
        <select name={`reference_source_${side}`} required value={file ? source : ""}
          onChange={(event) => setSource(event.target.value)}>
          <option value="">Choose an overlapping photo</option>
          {files.map((item, index) => (
            <option key={fileKey(item)} value={fileKey(item)}>{index + 1}. {item.name}</option>
          ))}
        </select>
      </label>
      {file && (
        <>
          <label>Endpoint to mark
            <select value={endpoint} onChange={(event) => setEndpoint(Number(event.target.value))}>
              <option value={0}>A</option><option value={1}>B</option>
            </select>
          </label>
          <img ref={attachPhoto} alt={`Reference photo ${side + 1}. Tap the selected measured endpoint; coordinates are also editable below.`}
            style={{ width: "100%", height: "auto", display: "block" }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const next = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
              setPixels((current) => current.map((point, index) => index === endpoint ? next : point));
              setEndpoint(1 - endpoint);
            }} />
        </>
      )}
      {pixels.map((point, index) => (
        <div key={index}>
          Endpoint {index ? "B" : "A"} (normalized image coordinates)
          {["x", "y"].map((axis, coordinate) => (
            <label key={axis}>{axis}
              <input type="number" min="0" max="1" step="any" required
                aria-label={`Reference photo ${side + 1}, endpoint ${index ? "B" : "A"}, ${axis} coordinate`}
                name={`reference_pixel_${side}_${index}_${coordinate}`} value={point[coordinate]}
                onChange={(event) => setPixels((current) => current.map((p, i) => i === index
                  ? p.map((value, j) => j === coordinate ? event.target.value : value) : p))} />
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}
export default function CaptureForm({ health, onCreated }) {
  const cache = useQueryClient();
  const [files, setFiles] = useState([]);
  const [name, setName] = useState("");
  const [engine, setEngine] = useState("architecture");
  const [dragging, setDragging] = useState(false);
  const [measuredReference, setMeasuredReference] = useState(false);
  const mutation = useMutation({
    mutationFn: (data) => request("/maps", { method: "POST", body: data }),
    onSuccess: (job) => {
      cache.setQueryData(["maps"], (current = []) => [
        job,
        ...current.filter((item) => item.id !== job.id),
      ]);
      cache.invalidateQueries({ queryKey: ["maps"] });
      onCreated(job.id);
    },
  });
  const suggestedName =
    files[0]?.name
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .slice(0, 100) || "New space";
  const problem = captureProblem(files, health);
  const canMeasure = engine === "architecture" && files.length >= 4 && files.every((file) => file.type.startsWith("image/"));
  function add(next) {
    if (mutation.isPending) return;
    mutation.reset();
    setFiles((current) => mergeFiles(current, next));
  }
  return (
    <section className="capture-home">
      <div className="capture-intro">
        <Icon name="cube" size={44} />
        <h1>Your space, in 3D.</h1>
        <p>Start with photos taken around the same space.</p>
      </div>
      <form
        className="capture-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!files.length || problem) return;
          const data = new FormData(event.currentTarget);
          data.set("name", name.trim() || suggestedName);
          data.set("engine", engine);
          files.forEach((file) => data.append("files", file));
          if (!data.get("calibration")) data.delete("calibration");
          if (measuredReference && canMeasure) {
            const sources = [0, 1].map((side) => files.findIndex((file) => fileKey(file) === data.get(`reference_source_${side}`)));
            if (sources.some((index) => index < 0)) return;
            data.set("scale_reference", JSON.stringify({
              source_a: `${String(sources[0]).padStart(5, "0")}.jpg`,
              source_b: `${String(sources[1]).padStart(5, "0")}.jpg`,
              pixels_a: [0, 1].map((point) => [0, 1].map((axis) => Number(data.get(`reference_pixel_0_${point}_${axis}`)))),
              pixels_b: [0, 1].map((point) => [0, 1].map((axis) => Number(data.get(`reference_pixel_1_${point}_${axis}`)))),
              distance_m: Number(data.get("reference_distance")),
              uncertainty_m: Number(data.get("reference_uncertainty")),
              provenance: data.get("reference_provenance"),
            }));
          }
          mutation.mutate(data);
        }}
      >
        <fieldset disabled={mutation.isPending}>
          <div
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget))
                setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              add([...e.dataTransfer.files]);
            }}
          >
            <label className="upload-target">
              <Icon name="upload" size={28} />
              <strong>
                {files.length ? "Add more photos" : "Choose photos or a video"}
              </strong>
              <span>or drop files here</span>
              <input
                className="sr-only"
                type="file"
                accept={accept}
                multiple
                onChange={(e) => {
                  add([...e.target.files]);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="hint">
              4 to 12 photos or 1 video · Up to {health?.max_upload_mb || 512}{" "}
              MB
            </p>
          </div>
          {files.length > 0 && (
            <div className="capture-files">
              <div className="section-row">
                <span>
                  {files.length} file{files.length !== 1 ? "s" : ""} selected
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setFiles([])}
                >
                  Clear
                </button>
              </div>
              <ul className="file-tray">
                {files.map((file, index) => (
                  <li key={fileKey(file)}>
                    <FilePreview file={file} />
                    <span title={file.name}>{file.name}</span>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setFiles(files.filter((_, i) => i !== index))
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div
            className="engine-options"
            role="group"
            aria-label="Modeling method"
          >
            <label className={engine === "architecture" ? "active" : ""}>
              <input
                type="radio"
                name="engine"
                checked={engine === "architecture"}
                onChange={() => setEngine("architecture")}
              />
              <span>
                1. Structured model<small>Editable rooms · Alexa+ Simulate via MCP</small>
              </span>
            </label>
            <label className={engine === "mapanything" ? "active" : ""}>
              <input
                type="radio"
                name="engine"
                checked={engine === "mapanything"}
                onChange={() => setEngine("mapanything")}
              />
              <span>
                2. MapAnything<small>Photo mesh · Meta / Carnegie Mellon</small>
              </span>
            </label>
          </div>
          <details className="capture-options">
            <summary>Name, camera & measured scale</summary>
            <label>
              Space name <span className="muted">optional</span>
              <input
                value={name}
                maxLength={100}
                placeholder={suggestedName}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Camera calibration JSON <span className="muted">optional</span>
              <textarea
                name="calibration"
                rows={3}
                placeholder="Use measured camera parameters if available."
              />
            </label>
            <p className="hint">Overlapping translated views automatically generate feature tracks and lens estimates. Model-frame calibration still needs observed photo-to-model anchors; lens estimates are not measured lens calibration.</p>
            {canMeasure && (
              <>
                <label><input type="checkbox" checked={measuredReference}
                  onChange={(event) => setMeasuredReference(event.target.checked)} />
                  Supply a physically measured reference distance
                </label>
                {measuredReference && (
                  <div>
                    <p>Choose the same two textured endpoints in two different overlapping photos, A then B in each. Tap to mark or enter normalized coordinates. Only shared triangulated feature tracks can resolve this measurement; otherwise scale stays unknown.</p>
                    {[0, 1].map((side) => <ReferenceView key={side} files={files} side={side} />)}
                    <label>Measured distance (metres)<input name="reference_distance" type="number" min="0.000001" max="1000" step="any" required /></label>
                    <label>Reported absolute uncertainty (metres)<input name="reference_uncertainty" type="number" min="0.000001" step="any" required /></label>
                    <label>Measurement provenance<input name="reference_provenance" maxLength={2000} required placeholder="Who measured which endpoints, instrument and date" /></label>
                    <p className="hint">A reported measurement is not a survey or proof of physical clearance. Do not enter a photo estimate or model dimension.</p>
                  </div>
                )}
              </>
            )}
          </details>
          {problem && (
            <p className="error" role="status">
              {problem}
            </p>
          )}
          <button
            className="primary capture-submit"
            disabled={!files.length || Boolean(problem)}
          >
            {mutation.isPending
              ? "Uploading…"
              : engine === "architecture"
                ? "Create space"
                : "Build photo mesh"}
            <Icon name="arrow" />
          </button>
        </fieldset>
        {mutation.error && (
          <p role="alert" className="error">
            {mutation.error.message}
          </p>
        )}
        <p className="capture-expectation">
          {engine === "architecture"
            ? "Next: copy one request to your external Alexa+ Simulate modeling conversation."
            : "Reconstruction runs on your server. You can leave and return."}
        </p>
      </form>
      <details className="capture-tips">
        <summary>Tips for a better capture</summary>
        <p>
          Move between positions with overlapping views. Include corners, both
          sides of doors, and stairs between floors. Keep the camera steady and
          avoid zooming.
        </p>
      </details>
    </section>
  );
}

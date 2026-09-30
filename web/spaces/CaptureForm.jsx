import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { request } from "./api";
import { FilePreview, Icon } from "./ui";
import { captureProblem, fileKey, mergeFiles } from "./capture";

const accept =
  "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/x-msvideo,.m4v";

export default function CaptureForm({ health, onCreated }) {
  const cache = useQueryClient();
  const [files, setFiles] = useState([]);
  const [name, setName] = useState("");
  const [engine, setEngine] = useState("architecture");
  const [dragging, setDragging] = useState(false);
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
                1. Structured model<small>Editable rooms · Codex via MCP</small>
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
            <summary>Name & camera settings</summary>
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
            ? "Next: copy one request to Codex to build your model."
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

import React, { useId, useRef, useState } from "react";

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "The request failed. Please try again.");
  return data;
}
export const careRequest = "Review my home. What needs care next?";
export async function uploadDocument(file, assetId = null) {
  const body = new FormData();
  body.set("file", file);
  return api(assetId ? `/api/assets/${assetId}/documents` : "/api/documents", {
    method: "POST",
    body,
  });
}
export const today = () => new Date().toLocaleDateString("en-CA");
export const dateText = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(`${value}T12:00:00`))
    : "No date";
export const moneyText = (amount, currency) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    amount /
      10 **
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits,
  );
export const emptyHome = {
  assets: [],
  documents: [],
  memories: [],
  tasks: [],
  task_history: [],
  maintenance: [],
  incidents: [],
  events: [],
  costs: [],
};
export const blankAsset = {
  name: "",
  room: "",
  category: "Home item",
  brand: "",
  model: "",
  serial: "",
  purchased_on: "",
  warranty_until: "",
  notes: "",
};

export function Mark({ size = 32, className }) {
  const id = useId();
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={id}
          x1="5"
          y1="5"
          x2="35"
          y2="36"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3ff2c7" />
          <stop offset="0.45" stopColor="#0abeff" />
          <stop offset="1" stopColor="#1a6bff" />
        </linearGradient>
      </defs>
      <path
        className="mark-roof"
        pathLength="1"
        d="M7 19 20 7l13 12v10c0 5-4 8-9 8H13c-4 0-7-3-7-7V19"
        stroke={`url(#${id})`}
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="mark-door"
        pathLength="1"
        d="M14 30V19m12 0v11m-12-6h12"
        stroke={`url(#${id})`}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
// Authored set: a fine line drawing, and on navigation icons one lit node that glows when active.
const icons = {
  home: ["M4 11.2 12 4.5l8 6.7v8.3a.9.9 0 0 1-.9.9H4.9a.9.9 0 0 1-.9-.9ZM9.8 20.4v-3.6a2.2 2.2 0 0 1 4.4 0v3.6", [12, 11.6]],
  threads: ["M3.6 7.2a2.6 2.6 0 0 1 2.6-2.6h8.2a2.6 2.6 0 0 1 2.6 2.6v4.4a2.6 2.6 0 0 1-2.6 2.6H9.6l-3.9 3.1v-3.1h.5a2.6 2.6 0 0 1-2.6-2.6ZM20.4 9.6v5.2a2.4 2.4 0 0 1-2.4 2.4v2.4l-3-2.4h-3.4", [7.6, 9.4]],
  scan: ["M3.5 8V5a1.5 1.5 0 0 1 1.5-1.5h3M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3M12 7.2l4.4 2.4v4.8L12 16.8l-4.4-2.4V9.6ZM7.6 9.6 12 12l4.4-2.4M12 12v4.8", [12, 12]],
  tag: ["M3.9 12.3 11.1 5h7.3a.9.9 0 0 1 .9.9v7.3l-7.2 7.3a1.3 1.3 0 0 1-1.9 0l-6.3-6.3a1.3 1.3 0 0 1 0-1.9Z", [15.6, 8.6]],
  sprout: ["M12 20.5v-7M12 13.5c0-4.6 3-7.6 8-7.6 0 4.8-3 7.6-8 7.6ZM12 15.6c0-3.6-2.4-6-6.6-6 0 3.8 2.4 6 6.6 6ZM7.5 20.5h9", [16.4, 9.4]],
  folio: ["M6.5 3.5h7.2l4.8 4.8v11a1.7 1.7 0 0 1-1.7 1.7h-10.3a1.7 1.7 0 0 1-1.7-1.7V5.2a1.7 1.7 0 0 1 1.7-1.7ZM13.5 3.5v5h5M8.5 13h7M8.5 16.5h4.5", [8.6, 8.6]],
  spiral: ["M12 12a1.5 1.5 0 0 1 3 0 3 3 0 0 1-6 0 4.5 4.5 0 0 1 9 0 6 6 0 0 1-12 0", [13.5, 12]],
  rings: ["M12 3.2c5 0 8.8 3.8 8.8 8.8s-3.9 8.8-8.8 8.8S3.2 17 3.2 12 7 3.2 12 3.2ZM12 7.4c2.6 0 4.6 2 4.6 4.6s-2 4.6-4.6 4.6-4.6-2-4.6-4.6 2-4.6 4.6-4.6ZM16.6 12l4.2-1.4", [12, 12]],
  beacon: ["M9.6 20.5 10.8 9h2.4l1.2 11.5M7.5 20.5h9M10.3 9V6.5h3.4V9M12 6.5V5M5 5.2l3 1.6M19 5.2l-3 1.6M4.4 9.6l3.2-.4M19.6 9.6l-3.2-.4", [12, 7.8]],
  dial: ["M12 6.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8ZM12 2.8v1.6M12 19.6v1.6M2.8 12h1.6M19.6 12h1.6M5.5 5.5l1.1 1.1M17.4 17.4l1.1 1.1M5.5 18.5l1.1-1.1M17.4 6.6l1.1-1.1M12 12l2.2-2.2", [14.4, 9.6]],
  plus: ["M12 5.5v13M5.5 12h13"],
  stop: ["M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"],
  lens: ["M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2.2h5.6L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5ZM12 9.4a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2"],
  arrow: ["M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"],
  back: ["M19 12H5.5M11 6.5 5.5 12l5.5 5.5"],
  close: ["m6.5 6.5 11 11M6.5 17.5l11-11"],
  check: ["m5 12.5 4.2 4L19 7"],
  clock: ["M12 7.5V12l3 2M20.8 12a8.8 8.8 0 1 1-17.6 0 8.8 8.8 0 0 1 17.6 0"],
  book: ["M4 3h13a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M3 17h17M8 7h8M8 11h5"],
  tools: ["m14 6 4 4M5 19l7-7M14 3a6 6 0 0 0-7 7L3 18a2 2 0 0 0 3 3l8-8a6 6 0 0 0 7-7l-4 4-3-3Z"],
  mic: ["M9.6 6a2.4 2.4 0 0 1 4.8 0v5a2.4 2.4 0 0 1-4.8 0ZM5.6 10.6a6.4 6.4 0 0 0 12.8 0M12 17v3.5M3.4 9v3M20.6 9v3"],
  send: ["M12 19.5V5.5M6.5 11 12 5.5l5.5 5.5"],
  file: ["M6.5 3.5h7.2l4.8 4.8v11a1.7 1.7 0 0 1-1.7 1.7h-10.3a1.7 1.7 0 0 1-1.7-1.7V5.2a1.7 1.7 0 0 1 1.7-1.7ZM13.5 3.5v5h5M8.5 13h7M8.5 16.5h4.5"],
  speaker: ["M4 10.5v3M8 7v10M12 4.5v15M16 8v8M20 10.5v3"],
  alert: ["M12 3.5 2.8 20h18.4ZM12 9.5v4.5M12 17v.5"],
  attach: ["M15.6 7.4 9 14a1.8 1.8 0 0 0 2.6 2.6l7-7a3.6 3.6 0 0 0-5.1-5.1l-7 7a5.4 5.4 0 0 0 7.6 7.6L20 13"],
  care: ["M12 20.5v-7M12 13.5c0-4.6 3-7.6 8-7.6 0 4.8-3 7.6-8 7.6ZM12 15.6c0-3.6-2.4-6-6.6-6 0 3.8 2.4 6 6.6 6ZM7.5 20.5h9"],
  memory: ["M12 12a1.5 1.5 0 0 1 3 0 3 3 0 0 1-6 0 4.5 4.5 0 0 1 9 0 6 6 0 0 1-12 0"],
  search: ["M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15.5 15.5l5 5"],
  settings: ["M12 6.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8ZM12 2.8v1.6M12 19.6v1.6M2.8 12h1.6M19.6 12h1.6M12 12l2.2-2.2"],
  edit: ["M4.5 19.5l4-1 10.6-10.6a2 2 0 0 0-3-3L5.5 15.5ZM14.5 6.5l3 3"],
  download: ["M12 3.5v11.5M7 10.5l5 5 5-5M4 16.5v2.5A1.5 1.5 0 0 0 5.5 20.5h13a1.5 1.5 0 0 0 1.5-1.5v-2.5"],
  cube: ["M3.5 8V5a1.5 1.5 0 0 1 1.5-1.5h3M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3M12 7.2l4.4 2.4v4.8L12 16.8l-4.4-2.4V9.6ZM7.6 9.6 12 12l4.4-2.4M12 12v4.8"],
};
export function Icon({ name, size = 20 }) {
  const [path, node] = icons[name] || icons.book;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
      {node && (
        <circle
          className="icon-node"
          cx={node[0]}
          cy={node[1]}
          r="1.9"
          stroke="none"
        />
      )}
    </svg>
  );
}
export function IconButton({ name, label, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={name} />
    </button>
  );
}
export function PageList({
  items,
  children,
  label = "records",
  empty = "Nothing here yet.",
  size = 8,
}) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(items.length / size),
    current = Math.min(page, Math.max(0, pages - 1));
  return (
    <>
      {items.length ? (
        children(items.slice(current * size, (current + 1) * size))
      ) : (
        <p className="empty-note">{empty}</p>
      )}
      {pages > 1 && (
        <nav className="pagination" aria-label={`${label} pages`}>
          <button
            className="text-button"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </button>
          <span aria-live="polite">
            {current + 1} / {pages}
          </span>
          <button
            className="text-button"
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </>
  );
}
export function Editor({ spec, onSave, onCancel, disabled = false }) {
  const [values, setValues] = useState(spec.values),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const fields = (advanced) =>
    spec.fields
      .filter((f) => Boolean(f.advanced) === advanced)
      .map(
        ({
          name,
          label,
          type = "text",
          required,
          options,
          maxLength = 12000,
        }) => (
          <label className="field" key={name}>
            <span>{label}</span>
            {options ? (
              <select
                aria-label={label}
                value={values[name] ?? ""}
                onChange={change}
                name={name}
              >
                {options.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : type === "textarea" ? (
              <textarea
                aria-label={label}
                rows={3}
                name={name}
                value={values[name] ?? ""}
                onChange={change}
                maxLength={maxLength}
                required={required}
              />
            ) : (
              <input
                aria-label={label}
                name={name}
                type={type}
                value={values[name] ?? ""}
                onChange={change}
                maxLength={500}
                required={required}
                step={type === "number" ? 1 : undefined}
              />
            )}
          </label>
        ),
      );
  function change(event) {
    setValues({ ...values, [event.target.name]: event.target.value });
    requestId.current = crypto.randomUUID();
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(spec.action, {
        ...spec.make(values),
        request_id: requestId.current,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="editor">
      <button className="text-button" onClick={onCancel} disabled={busy}>
        <Icon name="back" size={16} /> Back
      </button>
      <h2>{spec.title}</h2>
      {spec.description && <p className="muted">{spec.description}</p>}
      <form onSubmit={submit}>
        <fieldset disabled={busy || disabled}>
          {fields(false)}
          {spec.fields.some((f) => f.advanced) && (
            <details className="more-fields">
              <summary>More details</summary>
              {fields(true)}
            </details>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="primary" disabled={busy || disabled}>
            {busy ? "Saving…" : spec.submit || "Save"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
export function Timeline({ events, onAsset }) {
  return (
    <PageList
      items={events}
      label="History"
      empty="Completed work will appear here."
    >
      {(rows) => (
        <ol className="timeline">
          {rows.map((event) => (
            <li key={event.id}>
              <time dateTime={event.happened_on}>
                {dateText(event.happened_on)}
              </time>
              <h3>{event.summary}</h3>
              {event.asset_name && onAsset && (
                <button
                  className="text-button"
                  onClick={() => onAsset(event.asset_id)}
                >
                  {event.asset_name}
                </button>
              )}
              {event.detail && <p>{event.detail}</p>}
              {event.cost_minor != null && (
                <span className="amount">
                  {moneyText(event.cost_minor, event.currency)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </PageList>
  );
}
export function MessageText({ text, onItem }) {
  // Only inline emphasis and links are rendered. React escapes all user and model text.
  const inline = (line) =>
    line.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g).map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**"))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
      if (!link) return part;
      const item = /^\/\?item=([a-f\d-]{36})$/.exec(link[2]);
      if (item)
        return (
          <button
            key={index}
            className="inline-link"
            onClick={() => onItem(item[1])}
          >
            {link[1]}
          </button>
        );
      if (
        /^https?:\/\//.test(link[2]) ||
        /^\/api\/documents\/[a-f\d-]{36}\/download$/.test(link[2])
      )
        return (
          <a key={index} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      return link[1];
    });
  return (
    <div className="message-text">
      {text.split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>
          {paragraph.split("\n").map((line, j) => (
            <React.Fragment key={j}>
              {j > 0 && <br />}
              {inline(line.replace(/^#{1,6}\s+/, ""))}
            </React.Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

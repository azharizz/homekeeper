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

export function Mark({ size = 32 }) {
  const id = useId();
  return (
    <svg
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
          <stop stopColor="#06d9ed" />
          <stop offset="1" stopColor="#178bff" />
        </linearGradient>
      </defs>
      <path
        d="M7 19 20 7l13 12v10c0 5-4 8-9 8H13c-4 0-7-3-7-7V19"
        stroke={`url(#${id})`}
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 30V19m12 0v11m-12-6h12"
        stroke={`url(#${id})`}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function Icon({ name, size = 20 }) {
  const paths = {
    home: "M3 10 12 3l9 7v10h-6v-7H9v7H3Z",
    plus: "M12 5v14M5 12h14",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    back: "M19 12H5m6-6-6 6 6 6",
    close: "m6 6 12 12M6 18 18 6",
    check: "m5 12 4 4L19 6",
    clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    book: "M4 3h13a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M3 17h17M8 7h8M8 11h5",
    tools:
      "m14 6 4 4M5 19l7-7M14 3a6 6 0 0 0-7 7L3 18a2 2 0 0 0 3 3l8-8a6 6 0 0 0 7-7l-4 4-3-3Z",
    mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
    send: "M12 20V4m-6 6 6-6 6 6",
    file: "M14 2H5v20h14V7ZM14 2v5h5M8 12h8M8 16h8",
    speaker: "M4 9h4l5-4v14l-5-4H4ZM17 8a6 6 0 0 1 0 8",
    alert: "M12 3 2 21h20ZM12 9v5M12 17v1",
    attach: "m9 17 9-9a3 3 0 0 0-4-4L4 14a5 5 0 0 0 7 7L21 11M7 15l9-9",
    care: "m4 12 4 4 8-9M13 3H3v18h18V11",
    memory:
      "M8 3a4 4 0 0 0-4 5 5 5 0 0 0 0 8 4 4 0 0 0 8 3V6a3 3 0 0 0-4-3ZM16 3a4 4 0 0 1 4 5 5 5 0 0 1 0 8 4 4 0 0 1-8 3M7 9h5m0 6h5",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z",
    edit: "m15 4 5 5M4 20l5-1L21 7l-4-4L5 15Z",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.book} />
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
              <select value={values[name] ?? ""} onChange={change} name={name}>
                {options.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : type === "textarea" ? (
              <textarea
                rows={3}
                name={name}
                value={values[name] ?? ""}
                onChange={change}
                maxLength={maxLength}
                required={required}
              />
            ) : (
              <input
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

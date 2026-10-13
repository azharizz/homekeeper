import { Component, useState } from "react";

export function ErrorMessage({ error }) {
  return error ? (
    <p role="alert" className="error">
      {error.message}
    </p>
  ) : null;
}

// The outline vocabulary follows the user's Homekeeper interface.
export function Icon({ name, size = 20 }) {
  const paths = {
    cube: "m12 3 9 5v9l-9 5-9-5V8Zm0 10 9-5M3 8l9 5v9",
    plus: "M12 5v14M5 12h14",
    library: "M3 4h7v7H3Zm11 0h7v7h-7ZM3 15h7v6H3Zm11 0h7v6h-7Z",
    photo: "M3 3h18v18H3Zm0 13 6-6 8 11m-3-4 3-3 4 4M16 7h.01",
    camera: "M3 7h4l2-3h6l2 3h4v14H3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    back: "M19 12H5m6-6-6 6 6 6",
    close: "m6 6 12 12M6 18 18 6",
    check: "m5 12 4 4L19 6",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    copy: "M8 8h13v13H8ZM16 4V2H2v14h2",
    info: "M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
    focus: "M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M8 12h8m-4-4v8",
    plan: "M3 3h18v18H3ZM3 12h7m4 0h7M12 3v6m0 6v6",
    ruler: "M3 7h18v10H3ZM7 7v4m5-4v6m5-6v4",
    walk: "M14 3h.01M11 8l3-2 3 4 3 1M14 6l-2 7 4 3 1 5M12 13l-3 8M11 8l-4 4-3-1",
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
      <path d={paths[name]} />
    </svg>
  );
}

export function PageList({
  items,
  children,
  label,
  size = 6,
  empty = "No matches.",
}) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(items.length / size);
  const current = Math.min(page, Math.max(0, pages - 1));
  return (
    <>
      {items.length
        ? children(items.slice(current * size, (current + 1) * size))
        : empty && <p className="empty-note">{empty}</p>}
      {pages > 1 && (
        <nav className="pagination" aria-label={`${label} pages`}>
          <button
            type="button"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            <Icon name="back" size={16} /> Previous
          </button>
          <span aria-live="polite">
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next <Icon name="arrow" size={16} />
          </button>
        </nav>
      )}
    </>
  );
}

export function CopyAction({ text, label = "Copy request for Alexa+ Simulate" }) {
  const [state, setState] = useState("");
  return (
    <div className="copy-action">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("manual");
          }
        }}
      >
        <Icon name={state === "copied" ? "check" : "copy"} />
        {state === "copied" ? "Copied. Paste into your external conversation." : label}
      </button>
      {state === "copied" && (
        <span className="sr-only" role="status">
          Request copied to clipboard.
        </span>
      )}
      {state === "manual" && (
        <label>
          Clipboard unavailable. Copy this request.
          <textarea
            readOnly
            value={text}
            rows={4}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}

// Blob URLs belong to the displayed file and are released when it leaves the tray.
export class FilePreview extends Component {
  state = { url: null };
  componentDidMount() {
    this.url = URL.createObjectURL(this.props.file);
    this.setState({ url: this.url });
  }
  componentWillUnmount() {
    URL.revokeObjectURL(this.url);
  }
  render() {
    return this.props.file.type.startsWith("image/") && this.state.url ? (
      <img src={this.state.url} alt={this.props.file.name} />
    ) : (
      <Icon name="photo" size={28} />
    );
  }
}

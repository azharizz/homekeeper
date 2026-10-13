import { useRef, useState, useSyncExternalStore } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { request } from "./api";
import CaptureForm from "./CaptureForm";
import { ErrorMessage, Icon } from "./ui";
import Workspace from "./workspace/Workspace";
import Library from "./Library";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/model.css";
import "./styles/walkthrough.css";

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

const savedSpace = sessionStorage.getItem("roomtrace:space");
if (!window.location.hash && savedSpace)
  window.history.replaceState(
    null,
    "",
    `#${new URLSearchParams({ space: savedSpace })}`,
  );
const readSelection = () => window.location.hash.slice(1);
const subscribeSelection = (listener) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

function App({ home, onHomeChanged, onHomeItem, onHomeAction }) {
  const hash = useSyncExternalStore(subscribeSelection, readSelection);
  const selected = new URLSearchParams(hash).get("space");
  const targetElementId = new URLSearchParams(hash).get("element");
  const [library, setLibrary] = useState(false);
  const [help, setHelp] = useState(false);
  const libraryButton = useRef(null);
  const helpButton = useRef(null);
  const main = useRef(null);
  const closeLibrary = () => {
    setLibrary(false);
    libraryButton.current?.focus();
  };
  const closeHelp = () => {
    setHelp(false);
    helpButton.current?.focus();
  };
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => request("/health"),
  });
  const maps = useQuery({
    queryKey: ["maps"],
    queryFn: () => request("/maps"),
    refetchInterval: (query) =>
      query.state.data?.some(
        (job) =>
          ["queued", "running", "uploading", "awaiting_agent"].includes(
            job.status,
          ) ||
          (job.id === selected && job.options.engine === "architecture"),
      )
        ? 2000
        : false,
  });
  const job = maps.data?.find((item) => item.id === selected);
  function select(id) {
    if (id) sessionStorage.setItem("roomtrace:space", id);
    else sessionStorage.removeItem("roomtrace:space");
    window.location.hash = id
      ? new URLSearchParams({ space: id }).toString()
      : "";
    setLibrary(false);
    setHelp(false);
    main.current?.focus();
  }
  return (
    <div
      className="spaces-workspace"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (library) closeLibrary();
          if (help) closeHelp();
        }
      }}
    >
      <header className="module-toolbar">
        <h1>Spaces</h1>
        <nav aria-label="Spaces navigation">
          <button
            onClick={() => select(null)}
            aria-pressed={!selected && !library}
          >
            <Icon name="plus" /> New space
          </button>
          <button
            ref={libraryButton}
            aria-expanded={library}
            onClick={() => {
              setLibrary(!library);
              setHelp(false);
            }}
          >
            <Icon name="library" /> Your spaces
          </button>
        </nav>
        <button
          className="icon-button"
          ref={helpButton}
          aria-label="How Spaces works"
          aria-expanded={help}
          onClick={() => {
            setHelp(!help);
            setLibrary(false);
          }}
        >
          <Icon name="info" />
        </button>
      </header>
      {library && (
        <Library
          maps={maps.data || []}
          selected={selected}
          onSelect={select}
          onClose={closeLibrary}
        />
      )}
      {help && (
        <aside className="library-panel help-panel" aria-label="About Spaces">
          <div className="panel-heading">
            <h2>How it works</h2>
            <button
              className="icon-button"
              aria-label="Close help"
              onClick={closeHelp}
            >
              <Icon name="close" />
            </button>
          </div>
          <ol>
            <li>Add 4 to 12 overlapping photos or a video.</li>
            <li>
              For structured models, paste the supplied request into Codex.
              MapAnything runs on your server.
            </li>
            <li>
              Explore your model. Use Photos to compare, Objects to edit, and
              Camera to save a new view.
            </li>
          </ol>
          <p className="hint">
            This is an estimated model, not a verified walking aid. Physical
            position requires observed landmark matches.
          </p>
          <p className="hint">
            {health.data?.compute_device || "Local"} compute
          </p>
        </aside>
      )}
      <main id="spaces" aria-label="Spaces" ref={main} tabIndex={-1}>
        <ErrorMessage error={health.error || maps.error} />
        {(health.isError || maps.isError) && (
          <button
            onClick={() => {
              health.refetch();
              maps.refetch();
            }}
          >
            Try again
          </button>
        )}
        {job ? (
          <Workspace
            key={job.id}
            job={job}
            home={home}
            onHomeChanged={onHomeChanged}
            onHomeItem={onHomeItem}
            onHomeAction={onHomeAction}
            targetElementId={targetElementId}
          />
        ) : selected && maps.isPending ? (
          <p role="status" className="job-state">
            Opening your space…
          </p>
        ) : selected ? (
          <section className="job-state">
            <h1>Space unavailable</h1>
            <p>Open your library to choose a saved space.</p>
            <button onClick={() => setLibrary(true)}>Your spaces</button>
          </section>
        ) : (
          <CaptureForm health={health.data} onCreated={select} />
        )}
      </main>
      <footer className="module-footer">
        Estimated models. Not a verified walking aid.
      </footer>
    </div>
  );
}

export default function Spaces(props) {
  return (
    <QueryClientProvider client={client}>
      <App {...props} />
    </QueryClientProvider>
  );
}

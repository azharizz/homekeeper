import React, { lazy, Suspense, useState } from "react";
import { Conversation } from "./Conversation.jsx";
import { HomePanel } from "./HomePanel.jsx";
import {
  api,
  emptyHome,
  Icon,
  IconButton,
  Mark,
  PageList,
  uploadDocument,
} from "./components.jsx";

const Spaces = lazy(() => import("./spaces/Spaces.jsx"));

const navigation = [
  ["items", "book", "Your home"],
  ["care", "care", "Care & tasks"],
  ["files", "file", "Files"],
  ["memory", "memory", "Memory"],
  ["timeline", "clock", "Home history"],
];

export function App({ initial }) {
  const [home, setHome] = useState(initial[0].value || emptyHome),
    [status, setStatus] = useState(initial[1].value),
    [sessions, setSessions] = useState(initial[2].value || []);
  const [session, setSession] = useState(initial[3]?.value || null),
    [panel, setPanel] = useState(
      new URLSearchParams(location.search).get("view") === "spaces"
        ? "spaces"
        : new URLSearchParams(location.search).has("item")
          ? "items"
          : null,
    );
  const [itemId, setItemId] = useState(
      new URLSearchParams(location.search).get("item"),
    ),
    [draft, setDraft] = useState(""),
    [attachments, setAttachments] = useState([]);
  const [execution, setExecution] = useState(
      initial[3]?.value?.execution || "direct",
    ),
    [busy, setBusy] = useState(false),
    [activity, setActivity] = useState("");
  const [chatError, setChatError] = useState(""),
    [error, setError] = useState(
      initial
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason.message)
        .join(" "),
    );
  const [chatSearch, setChatSearch] = useState(""),
    [context, setContext] = useState([]);
  async function refresh() {
    const [h, s, conversations] = await Promise.all([
      api("/api/home"),
      api("/api/status"),
      api("/api/conversations"),
    ]);
    setHome(h);
    setStatus(s);
    setSessions(conversations);
    setError("");
  }
  async function saveHomeAction(action, values) {
    const route =
      [
        "link_space_object",
        "save_spatial_location",
        "save_spatial_task",
        "schedule_spatial_maintenance",
      ].includes(action)
        ? `/api/ui-actions/${action}`
        : `/api/actions/${action}`;
    const result = await api(route, {
      method: "POST",
      body: JSON.stringify({ ...values, request_id: crypto.randomUUID() }),
    });
    await refresh();
    return result;
  }
  async function send(input, consumeDraft = false) {
    if (busy) return;
    setBusy(true);
    setChatError("");
    setActivity("Reading your home");
    let current = session;
    try {
      current ||= await api("/api/conversations", { method: "POST" });
      const payload = input.message ? { ...input, execution } : input;
      setSession({
        ...current,
        state: "running",
        nextSteps: [],
        messages: [
          ...current.messages,
          ...(input.message ? [{ role: "user", content: input.message }] : []),
        ],
      });
      const response = await fetch(`/api/conversations/${current.id}/turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Could not send this message.",
        );
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        finished = false;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "activity") setActivity(event.text);
          if (event.type === "error") throw new Error(event.error);
          if (event.type === "session") {
            setSession(event.session);
            finished = true;
          }
        }
        if (done) break;
      }
      if (!finished)
        throw new Error(
          "The connection ended. Reopen this conversation to recover saved progress.",
        );
      if (input.message && consumeDraft) {
        setDraft("");
        setAttachments([]);
        setContext([]);
      }
      await refresh();
    } catch (e) {
      setChatError(e.message);
      if (current) {
        try {
          setSession(await api(`/api/conversations/${current.id}`));
        } catch {
          /* Preserve visible progress while the host is unavailable. */
        }
      }
    } finally {
      setBusy(false);
      setActivity("");
    }
  }
  async function upload(file) {
    if (busy || !file) return;
    setBusy(true);
    setChatError("");
    setActivity("Reading document");
    try {
      const doc = await uploadDocument(file);
      setAttachments((prior) => [...prior, doc]);
      await refresh();
    } catch (e) {
      setChatError(e.message);
    } finally {
      setBusy(false);
      setActivity("");
    }
  }
  async function select(id) {
    if (busy) return;
    setChatError("");
    setBusy(true);
    try {
      const next = id ? await api(`/api/conversations/${id}`) : null;
      setSession(next);
      setExecution(next?.execution || "direct");
      setDraft("");
      setAttachments([]);
      setContext([]);
      setPanel(null);
    } catch (e) {
      setChatError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const blocked =
    busy ||
    !status?.model_configured ||
    Boolean(session?.pending.length) ||
    ["running", "error"].includes(session?.state);
  function ask(text, { immediate = false, readOnly = false } = {}) {
    if (blocked) {
      setChatError(
        "Finish or recover the current conversation before starting another request.",
      );
      return;
    }
    setPanel(null);
    if (immediate) void send({ message: text, read_only: readOnly });
    else {
      setContext(
        [
          ...text.matchAll(/(Home item|Document) reference: ([a-f\d-]{36})/g),
        ].map((m) => ({ type: m[1], id: m[2] })),
      );
      setDraft(
        text.replace(/\n\n(?:Home item|Document) reference: [a-f\d-]{36}/g, ""),
      );
    }
  }
  const openItem = (id) => {
    setItemId(id);
    setPanel("items");
  };
  const openSpatialTarget = (spaceId, elementId) => {
    window.location.hash = new URLSearchParams({
      space: spaceId,
      element: elementId,
    }).toString();
    sessionStorage.setItem("roomtrace:space", spaceId);
    setPanel("spaces");
  };
  const togglePanel = (name) => {
    setPanel(panel === name ? null : name);
    setItemId(null);
  };
  const title =
    navigation.find(([name]) => name === panel)?.[2] ||
    (panel === "chats" ? "Conversations" : "Settings");
  return (
    <div
      className={`app-shell ${panel && panel !== "spaces" ? "panel-open" : ""}`}
    >
      <a
        className="skip-link"
        href={panel === "spaces" ? "#spaces" : "#message"}
      >
        {panel === "spaces" ? "Skip to Spaces" : "Skip to conversation"}
      </a>
      <header className="app-header">
        <button
          className="brand"
          onClick={() => setPanel(null)}
          aria-label="HomeKeeper home"
        >
          <Mark />
          <span>homekeeper</span>
        </button>
        <IconButton
          name="settings"
          label="Settings"
          className="settings-toggle"
          aria-expanded={panel === "settings"}
          onClick={() => togglePanel("settings")}
        />
      </header>
      <nav className="rail" aria-label="HomeKeeper navigation">
        <button
          className={`rail-button ${!panel ? "active" : ""}`}
          aria-label="Conversation"
          aria-current={!panel ? "page" : undefined}
          onClick={() => setPanel(null)}
        >
          <Icon name="home" />
          <span className="tooltip">Conversation</span>
        </button>
        <button
          className={`rail-button ${panel === "chats" ? "active" : ""}`}
          aria-label="Conversations"
          aria-expanded={panel === "chats"}
          onClick={() => togglePanel("chats")}
        >
          <Icon name="clock" />
          <span className="tooltip">Conversations</span>
        </button>
        <span className="rail-divider" />
        <button
          className={`rail-button ${panel === "spaces" ? "active" : ""}`}
          aria-label="Spaces"
          aria-current={panel === "spaces" ? "page" : undefined}
          onClick={() => togglePanel("spaces")}
        >
          <Icon name="cube" />
          <span className="tooltip">Spaces</span>
        </button>
        {navigation.map(([name, icon, label]) => (
          <button
            key={name}
            className={`rail-button ${panel === name ? "active" : ""}`}
            aria-label={label}
            aria-expanded={panel === name}
            onClick={() => togglePanel(name)}
          >
            <Icon name={icon} />
            <span className="tooltip">{label}</span>
          </button>
        ))}
      </nav>
      {error && (
        <div className="global-error error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => refresh().catch((e) => setError(e.message))}
          >
            Reconnect
          </button>
        </div>
      )}
      <Conversation
        hidden={panel === "spaces"}
        home={home}
        status={status}
        session={session}
        draft={draft}
        setDraft={setDraft}
        attachments={attachments}
        setAttachments={setAttachments}
        context={context}
        setContext={setContext}
        execution={execution}
        setExecution={setExecution}
        busy={busy}
        blocked={blocked}
        activity={activity}
        error={chatError}
        setError={setChatError}
        onSend={send}
        onUpload={upload}
        onSelect={select}
        onItem={openItem}
        onAsk={ask}
      />
      {panel === "spaces" && (
        <Suspense
          fallback={
            <main className="spaces-loading" role="status">
              Opening Spaces…
            </main>
          }
        >
          <Spaces
            home={home}
            onHomeChanged={refresh}
            onHomeItem={openItem}
            onHomeAction={saveHomeAction}
          />
          </Suspense>
      )}
      {panel && panel !== "spaces" && (
        <aside
          className="side-panel"
          aria-label={title}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPanel(null);
          }}
        >
          <header className="panel-header">
            <h1>{title}</h1>
            <IconButton
              name="close"
              label={`Close ${title}`}
              onClick={() => setPanel(null)}
            />
          </header>
          <div className="panel-body">
            {navigation.some(([name]) => name === panel) && (
              <HomePanel
                key={`${panel}:${itemId || ""}`}
                view={panel}
                itemId={itemId}
                home={home}
                busy={busy}
                canAsk={!blocked}
                onChanged={refresh}
                onItem={openItem}
                onBack={() => setItemId(null)}
                onAsk={ask}
                onShowSpace={openSpatialTarget}
              />
            )}
            {panel === "chats" && (
              <>
                <button
                  className="primary full-width"
                  disabled={busy}
                  onClick={() => select(null)}
                >
                  <Icon name="plus" size={16} /> New conversation
                </button>
                <label className="search">
                  <Icon name="search" size={18} />
                  <input
                    aria-label="Search conversations"
                    placeholder="Search conversations"
                    value={chatSearch}
                    onChange={(e) => setChatSearch(e.target.value)}
                  />
                </label>
                <PageList
                  key={chatSearch}
                  items={sessions.filter((s) =>
                    s.title.toLowerCase().includes(chatSearch.toLowerCase()),
                  )}
                  label="Conversations"
                  empty="Your conversations will appear here."
                >
                  {(rows) => (
                    <div className="record-list">
                      {rows.map((s) => (
                        <button
                          className={`record-row ${s.id === session?.id ? "selected" : ""}`}
                          disabled={busy}
                          key={s.id}
                          onClick={() => select(s.id)}
                        >
                          <span>
                            <strong>{s.title}</strong>
                            <small>
                              {new Date(s.updated_at).toLocaleDateString()}
                            </small>
                          </span>
                          <Icon name="arrow" size={16} />
                        </button>
                      ))}
                    </div>
                  )}
                </PageList>
              </>
            )}
            {panel === "settings" && (
              <section className="settings-content">
                <h2>Your local home</h2>
                <p>
                  {status?.capability
                    ? "Home records connected"
                    : "Home records unavailable"}
                </p>
                <p>
                  {status?.model_configured
                    ? "Nebius agent configured"
                    : "Nebius needs configuration"}
                </p>
                <h2>Saving records</h2>
                <label className="toggle-setting">
                  <input
                    type="checkbox"
                    checked={execution === "review"}
                    disabled={busy}
                    onChange={(e) =>
                      setExecution(e.target.checked ? "review" : "direct")
                    }
                  />
                  Review every change before saving
                </label>
                <p className="muted">
                  Requested saves run directly. Deletions and cancellations
                  always ask first.
                </p>
                <h2>Memory & privacy</h2>
                <p>
                  Nebius reads the context needed to help. Originals and history
                  stay in your local Docker volumes.
                </p>
                <p>
                  This is a local host. Alexa account access, device control,
                  bookings, purchases and delivered reminders are not connected.
                  Browser dictation uses your browser’s speech service.
                </p>
                <a className="secondary" href="/api/export" download>
                  <Icon name="download" size={17} /> Export home records
                </a>
                <details>
                  <summary>Agent activity</summary>
                  {session?.contextReadAt && (
                    <p className="muted">
                      Records read{" "}
                      {new Date(session.contextReadAt).toLocaleString()}
                    </p>
                  )}
                  <PageList
                    items={(session?.messages || [])
                      .filter((m) => m.role === "tool")
                      .toReversed()}
                    label="Tool activity"
                    size={5}
                    empty="No tool activity in this conversation."
                  >
                    {(rows) =>
                      rows.map((m, i) => (
                        <details key={i}>
                          <summary>{m.name.replaceAll("_", " ")}</summary>
                          <pre>{m.content}</pre>
                        </details>
                      ))
                    }
                  </PageList>
                </details>
              </section>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

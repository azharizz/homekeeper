import React, { useRef, useState } from "react";
import {
  api,
  blankAsset,
  careRequest,
  dateText,
  Editor,
  Icon,
  IconButton,
  Mark,
  PageList,
  Timeline,
  today,
  uploadDocument,
} from "./components.jsx";
import HomeSpatialCard from "./HomeSpatialCard.jsx";

export function HomePanel({
  view,
  itemId,
  home,
  busy,
  canAsk,
  onChanged,
  onItem,
  onBack,
  onAsk,
  onShowSpace,
}) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("open"),
    [editor, setEditor] = useState(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const requests = useRef(new Map());
  const asset = home.assets.find((a) => a.id === itemId),
    currentDate = home.today || today();
  const matches = (value) => value.toLowerCase().includes(search.toLowerCase());
  const assetName = (id) => home.assets.find((item) => item.id === id)?.name || "";
  const linkedSpaceObjects = (home.space_objects || []).filter(
    (item) => item.asset_id === asset?.id,
  );
  const locationMemories = home.memories.filter(
    (memory) => memory.asset_id === asset?.id && memory.kind === "location",
  );
  const forItem = (text, id = itemId) =>
    `${text}\n\nHome item reference: ${id}`;
  async function save(action, args) {
    const route = action === "save_memory" && Object.hasOwn(args, "space_id")
      ? "/api/ui-actions/save_spatial_location"
      : `/api/actions/${action}`;
    await api(route, {
      method: "POST",
      body: JSON.stringify(args),
    });
    await onChanged();
    setEditor(null);
  }
  async function complete(task) {
    if (busy || working) return;
    setWorking(true);
    setError("");
    setNotice("");
    const maintenance = task.type === "maintenance";
    const args = maintenance
      ? {
          maintenance_id: task.id,
          expected_due_on: task.due_on,
          completed_on: currentDate,
        }
      : {
          task_id: task.id,
          expected_revision: task.revision,
          completed_on: currentDate,
        };
    const key = JSON.stringify(args);
    if (!requests.current.has(key))
      requests.current.set(key, crypto.randomUUID());
    try {
      await save(maintenance ? "complete_maintenance" : "complete_task", {
        ...args,
        request_id: requests.current.get(key),
      });
      setNotice(`Done: ${task.title}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function upload(file) {
    if (!file || working) return;
    setWorking(true);
    setError("");
    try {
      await uploadDocument(file, asset?.id);
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  function editAsset(item) {
    setEditor({
      title: item ? "Edit item" : "Add an item",
      action: "save_home_item",
      values: item || blankAsset,
      fields: [
        { name: "name", label: "Item name", required: true },
        { name: "room", label: "Room" },
        ...[
          ["category", "Type"],
          ["brand", "Manufacturer"],
          ["model", "Model"],
          ["serial", "Serial number"],
          ["purchased_on", "Purchase date", "date"],
          ["warranty_until", "Warranty end", "date"],
          ["notes", "Notes", "textarea"],
        ].map(([name, label, type]) => ({ name, label, type, advanced: true })),
      ],
      make: (v) => ({
        ...Object.fromEntries(
          Object.keys(blankAsset).map((key) => [
            key,
            v[key] ||
              (key.endsWith("_on") || key.endsWith("_until")
                ? null
                : key === "category"
                  ? "Home item"
                  : ""),
          ]),
        ),
        ...(item ? { asset_id: item.id } : {}),
      }),
    });
  }
  function editTask(task, linkedAssetId = null) {
    setEditor({
      title:
        task?.status === "done" || task?.status === "cancelled"
          ? "Reopen task"
          : task
            ? "Edit task"
            : linkedAssetId
              ? "Add a task for this item"
              : "Add a task",
      action: "save_task",
      values: task
        ? { ...task, status: "open" }
        : {
            title: "",
            kind: "task",
            due_on: "",
            interval_days: "",
            notes: "",
            status: "open",
          },
      fields: [
        { name: "title", label: "Task", required: true },
        { name: "due_on", label: "Due date", type: "date", advanced: true },
        {
          name: "kind",
          label: "List",
          options: ["task", "shopping", "routine"],
          advanced: true,
        },
        {
          name: "interval_days",
          label: "Repeat every (days)",
          type: "number",
          advanced: true,
        },
        { name: "notes", label: "Notes", type: "textarea", advanced: true },
        ...(task
          ? [
              {
                name: "status",
                label: "Status",
                options: ["open", "cancelled"],
                advanced: true,
              },
            ]
          : []),
      ],
      make: (v) => ({
        title: v.title,
        due_on: v.due_on || null,
        kind: v.kind,
        interval_days: v.interval_days ? Number(v.interval_days) : null,
        notes: v.notes,
        status: v.status,
        asset_id: task?.asset_id || linkedAssetId || null,
        ...(task ? { task_id: task.id, expected_revision: task.revision } : {}),
      }),
    });
  }
  function editMaintenance(task, linkedAssetId = null) {
    const creating = !task;
    setEditor({
      title: creating ? "Schedule maintenance for this item" : "Edit care plan",
      action: creating ? "schedule_maintenance" : "update_maintenance",
      values: task || { title: "", due_on: "", interval_days: "", source: "" },
      fields: [
        { name: "title", label: "Task", required: true },
        { name: "due_on", label: "Next due", type: "date", required: true },
        {
          name: "interval_days",
          label: "Repeat every (days)",
          type: "number",
          advanced: true,
        },
        {
          name: "source",
          label: "Schedule source",
          required: true,
          advanced: true,
        },
      ],
      make: (v) =>
        creating
          ? {
              asset_id: linkedAssetId,
              title: v.title,
              due_on: v.due_on,
              interval_days: v.interval_days ? Number(v.interval_days) : null,
              source: v.source,
            }
          : {
              maintenance_id: task.id,
              expected_due_on: task.due_on,
              expected_revision: task.revision,
              title: v.title,
              due_on: v.due_on,
              interval_days: v.interval_days ? Number(v.interval_days) : null,
              source: v.source,
            },
    });
  }
  function editMemory(memory) {
    setEditor({
      title: memory ? "Edit memory" : "Remember something",
      action: "save_memory",
      values: memory || { title: "", content: "", kind: "fact" },
      fields: [
        { name: "title", label: "Title", required: true },
        {
          name: "content",
          label: "What to remember",
          type: "textarea",
          required: true,
          maxLength: 500,
        },
        {
          name: "kind",
          label: "Type",
          options: ["fact", "location", "contact", "preference"],
          advanced: true,
        },
      ],
      make: (v) => ({
        title: v.title,
        content: v.content,
        kind: v.kind,
        source: "Recorded by the household in HomeKeeper",
        ...(!memory ? { asset_id: null } : {}),
        ...(memory?.space_id && v.kind !== "location" ? { space_id: null, element_id: null } : {}),
        ...(memory
          ? { memory_id: memory.id, expected_revision: memory.revision }
          : {}),
      }),
    });
  }
  function forget(memory) {
    setEditor({
      title: `Forget “${memory.title}”?`,
      description:
        "Removes this saved memory. Earlier conversations and backups still retain it.",
      action: "forget_memory",
      submit: "Remove memory",
      values: {},
      fields: [],
      make: () => ({
        memory_id: memory.id,
        expected_revision: memory.revision,
      }),
    });
  }
  const searchBox = (placeholder) => (
    <label className="search">
      <Icon name="search" size={17} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </label>
  );
  const uploadControl = (
    <label
      className={`secondary upload-button ${working || busy ? "disabled" : ""}`}
    >
      <Icon name="attach" size={17} />
      {working ? "Reading file…" : "Add file"}
      <input
        type="file"
        aria-label="Upload PDF or text"
        accept=".pdf,.txt"
        disabled={working || busy}
        onChange={(e) => {
          void upload(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
  const files = (documents) => (
    <PageList
      key={search}
      items={documents.filter((d) =>
        matches(`${d.title} ${assetName(d.asset_id) || "unfiled"}`),
      )}
      label="Files"
      empty="Add a manual, receipt or warranty PDF. Searchable PDF or text, up to 12 MB."
    >
      {(rows) => (
        <div className="record-list">
          {rows.map((doc) => (
            <article className="file-row" key={doc.id}>
              <Icon name="file" />
              <div>
                <a href={`/api/documents/${doc.id}/download`}>{doc.title}</a>
                <small>
                  {assetName(doc.asset_id) || "Not filed yet"} ·{" "}
                  {doc.page_count} {doc.page_count === 1 ? "page" : "pages"}
                </small>
                <button
                  className="text-button"
                  disabled={!canAsk}
                  onClick={() =>
                    onAsk(
                      `${doc.asset_id ? "Summarize the useful care information in this document." : "Read this document and file it with the right item in my home. Add the item if needed, using only facts from the document."}\n\nDocument reference: ${doc.id}`,
                      { immediate: true, readOnly: Boolean(doc.asset_id) },
                    )
                  }
                >
                  {doc.asset_id ? "Ask about this" : "Organize for me"}
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </PageList>
  );
  const careRows = [
    ...home.tasks
      .filter((t) => t.status === "open")
      .map((t) => ({ ...t, type: "task" })),
    ...home.maintenance.map((m) => ({ ...m, type: "maintenance" })),
  ].sort((a, b) => (a.due_on || "9999").localeCompare(b.due_on || "9999"));
  const renderTasks = (tasks) => (
    <PageList
      key={`${search}:${filter}`}
      items={tasks.filter((t) =>
        matches(`${t.title} ${t.notes || ""} ${assetName(t.asset_id) || ""}`),
      )}
      label="Care"
      empty="No tasks here. Add one or ask HomeKeeper to plan care."
    >
      {(rows) => (
        <div className="record-list">
          {rows.map((task) => (
            <article className="task-row" key={task.id}>
              <button
                className="complete-button"
                aria-label={`Complete ${task.title}`}
                title={
                  task.last_completed_on === currentDate
                    ? "Completed today"
                    : "Mark done today"
                }
                disabled={
                  working || busy || task.last_completed_on === currentDate
                }
                onClick={() => complete(task)}
              >
                <Icon name="check" size={16} />
              </button>
              <div>
                <strong>{task.title}</strong>
                <small
                  className={
                    task.due_on && task.due_on < currentDate ? "overdue" : ""
                  }
                >
                  {task.last_completed_on === currentDate
                    ? "Done today · Next "
                    : task.due_on && task.due_on < currentDate
                      ? "Overdue · "
                      : ""}
                  {task.due_on ? dateText(task.due_on) : "No date"}
                  {task.interval_days
                    ? ` · Every ${task.interval_days} days`
                    : ""}
                </small>
                {task.asset_id && (
                  <button
                    className="text-button"
                    onClick={() => onItem(task.asset_id)}
                  >
                    {assetName(task.asset_id)}
                  </button>
                )}
                {task.notes && <p>{task.notes}</p>}
                {task.space_id && task.element_id && (
                  <HomeSpatialCard
                    record={task}
                    revision={task.space_revision ?? task.linked_revision}
                    kind="care"
                    actionLabel={`${task.space_name} · ${task.element_label} — Open in Spaces`}
                    onShowSpace={onShowSpace}
                  />
                )}
              </div>
              <IconButton
                name="edit"
                label={`Edit ${task.title}`}
                disabled={busy || working}
                onClick={() =>
                  task.type === "maintenance"
                    ? editMaintenance(task)
                    : editTask(task)
                }
              />
            </article>
          ))}
        </div>
      )}
    </PageList>
  );
  const issues = (rows) => (
    <PageList
      key={search}
      items={rows.filter((i) => matches(`${i.symptom} ${i.asset_name}`))}
      label="Issues"
      empty="No open issues recorded."
    >
      {(page) => (
        <div className="record-list">
          {page.map((issue) => (
            <article className="issue-row" key={issue.id}>
              <small>
                {issue.asset_name} · {dateText(issue.opened_on)}
              </small>
              <h3>{issue.symptom}</h3>
              <div className="row-actions">
                <button
                  className="text-button"
                  disabled={!canAsk}
                  onClick={() =>
                    onAsk(
                      forItem(
                        `Help with the open issue: ${issue.symptom}. Use the actual history and relevant documents.`,
                        issue.asset_id,
                      ),
                      { immediate: true, readOnly: true },
                    )
                  }
                >
                  Help me troubleshoot
                </button>
                <button
                  className="text-button"
                  disabled={!canAsk}
                  onClick={() =>
                    onAsk(
                      forItem(
                        `The issue “${issue.symptom}” was fixed. Here is what happened: `,
                        issue.asset_id,
                      ),
                    )
                  }
                >
                  Record the fix
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </PageList>
  );
  const history = [
    ...home.events,
    ...home.task_history.map((t) => ({
      ...t,
      happened_on: t.completed_on,
      summary: t.title,
      detail: t.notes,
      kind: "task",
      cost_minor: null,
    })),
  ].sort((a, b) => b.happened_on.localeCompare(a.happened_on));
  return (
    <>
      <p className="panel-notice" role="status">
        {notice}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editor ? (
        <Editor
          key={editor.title}
          spec={editor}
          disabled={busy}
          onSave={save}
          onCancel={() => setEditor(null)}
        />
      ) : (
        <>
          {view === "items" && !itemId && (
            <>
              <div className="panel-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => editAsset(null)}
                >
                  <Icon name="plus" size={16} /> Add item
                </button>
                <button
                  className="text-button"
                  disabled={!canAsk}
                  onClick={() =>
                    onAsk(
                      "Help me remember the things in my home. Start with one room.",
                      { immediate: true },
                    )
                  }
                >
                  Add through chat
                </button>
              </div>
              {searchBox("Find an item or room")}
              <PageList
                key={search}
                items={home.assets.filter((a) =>
                  matches(
                    `${a.name} ${a.room} ${a.category} ${a.brand} ${a.model}`,
                  ),
                )}
                label="Items"
                empty="Add an item, or attach its receipt in chat."
              >
                {(rows) => (
                  <div className="record-list">
                    {rows.map((a) => (
                      <button
                        className="record-row item-row"
                        key={a.id}
                        onClick={() => onItem(a.id)}
                      >
                        <span>
                          <strong>{a.name}</strong>
                          <small>
                            {[a.room, a.brand, a.model]
                              .filter(Boolean)
                              .join(" · ") || a.category}
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
          {view === "items" &&
            itemId &&
            (asset ? (
              <section className="passport">
                <button className="text-button" onClick={onBack}>
                  <Icon name="back" size={16} /> All items
                </button>
                <div className="passport-title">
                  <div>
                    <h2>{asset.name}</h2>
                    <p className="muted">
                      {[asset.room, asset.brand, asset.model]
                        .filter(Boolean)
                        .join(" · ") || asset.category}
                    </p>
                  </div>
                  <IconButton
                    name="edit"
                    label="Edit item"
                    disabled={busy}
                    onClick={() => editAsset(asset)}
                  />
                </div>
                <div className="passport-actions">
                  <button
                    className="secondary"
                    disabled={!canAsk}
                    onClick={() =>
                      onAsk(forItem(`Help me look after ${asset.name}.`), {
                        immediate: true,
                        readOnly: true,
                      })
                    }
                  >
                    Ask HomeKeeper
                  </button>
                  <button
                    className="text-button"
                    disabled={!canAsk}
                    onClick={() =>
                      onAsk(
                        forItem(
                          `Prepare a concise service brief for ${asset.name}, including identity, open symptoms, relevant repair history, known parts and costs. Use only saved evidence.`,
                        ),
                        { immediate: true, readOnly: true },
                      )
                    }
                  >
                    Service brief
                  </button>
                </div>
                {asset.warranty_until && (
                  <p className="warranty-note">
                    Reported warranty{" "}
                    {asset.warranty_until < currentDate ? "ended" : "until"}{" "}
                    {dateText(asset.warranty_until)}
                  </p>
                )}
                <details className="record-section">
                  <summary>Item details</summary>
                  <dl>
                    {[
                      ["Type", asset.category],
                      ["Serial", asset.serial],
                      [
                        "Purchased",
                        asset.purchased_on && dateText(asset.purchased_on),
                      ],
                    ]
                      .filter(([, v]) => v)
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                  </dl>
                  {asset.notes && <p>{asset.notes}</p>}
                </details>
                {linkedSpaceObjects.length > 0 && (
                  <section className="passport-section">
                    <h3>3D model objects</h3>
                    {linkedSpaceObjects.map((linked) => (
                      <HomeSpatialCard
                        key={`${linked.space_id}:${linked.element_id}`}
                        record={linked}
                        revision={linked.revision}
                        actionLabel={`${linked.space_name} · ${linked.element_label} — Open in Spaces`}
                        onShowSpace={onShowSpace}
                      />
                    ))}
                  </section>
                )}
                {locationMemories.length > 0 && (
                  <section className="passport-section">
                    <h3>Remembered storage locations</h3>
                    {locationMemories.map((memory) => (
                      memory.space_id && memory.element_id ? (
                        <HomeSpatialCard
                          key={memory.id}
                          record={memory}
                          revision={memory.space_revision ?? memory.linked_revision}
                          kind="storage"
                          title={memory.title}
                          description={memory.content}
                          storedItem={asset.name}
                          actionLabel={`${memory.space_name} · ${memory.element_label} — Show in Spaces`}
                          onShowSpace={onShowSpace}
                        />
                      ) : (
                        <article className="home-location-note" key={memory.id}>
                          <span className="home-spatial-badge">Storage place</span>
                          <strong>{memory.title}</strong>
                          <p>{memory.content}</p>
                        </article>
                      )
                    ))}
                  </section>
                )}
                {home.incidents.some((i) => i.asset_id === asset.id) && (
                  <section className="passport-section">
                    <h3>Open issues</h3>
                    {issues(
                      home.incidents.filter((i) => i.asset_id === asset.id),
                    )}
                  </section>
                )}
                <details className="record-section">
                  <summary>Care & tasks</summary>
                  {renderTasks(careRows.filter((t) => t.asset_id === asset.id))}
                  <button
                    className="text-button"
                    disabled={!canAsk}
                    onClick={() =>
                      onAsk(forItem(`Help me plan care for ${asset.name}.`), {
                        immediate: true,
                        readOnly: true,
                      })
                    }
                  >
                    Plan care
                  </button>
                </details>
                <details className="record-section">
                  <summary>
                    Files ·{" "}
                    {
                      home.documents.filter((d) => d.asset_id === asset.id)
                        .length
                    }
                  </summary>
                  {files(home.documents.filter((d) => d.asset_id === asset.id))}
                  {uploadControl}
                </details>
                <details className="record-section">
                  <summary>History</summary>
                  <Timeline
                    events={home.events.filter((e) => e.asset_id === asset.id)}
                  />
                  <a
                    className="text-button"
                    href={`/api/assets/${asset.id}/report`}
                    download
                  >
                    <Icon name="download" size={15} /> Download item history
                  </a>
                </details>
                <button
                  className="text-button"
                  disabled={!canAsk}
                  onClick={() =>
                    onAsk(forItem(`I have an update about ${asset.name}: `))
                  }
                >
                  Record a problem or past work
                  <Icon name="arrow" size={14} />
                </button>
              </section>
            ) : (
              <p className="empty-note">
                This item is no longer available.
                <button className="text-button" onClick={onBack}>
                  All items
                </button>
              </p>
            ))}
          {view === "care" && (
            <>
              <button
                className="primary full-width"
                disabled={!canAsk}
                onClick={() =>
                  onAsk(careRequest, { immediate: true, readOnly: true })
                }
              >
                <Mark size={21} /> Review my home
              </button>
              <div className="filter-bar">
                <select
                  aria-label="Care view"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="open">To do</option>
                  <option value="issues">Open issues</option>
                  <option value="done">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => editTask(null)}
                >
                  <Icon name="plus" size={16} /> Add task
                </button>
              </div>
              {searchBox("Find care or tasks")}
              {filter === "open" ? (
                renderTasks(careRows)
              ) : filter === "issues" ? (
                issues(home.incidents)
              ) : filter === "cancelled" ? (
                <PageList
                  key={search}
                  items={home.tasks.filter(
                    (t) => t.status === "cancelled" && matches(t.title),
                  )}
                  label="Cancelled tasks"
                  empty="No cancelled tasks."
                >
                  {(rows) => (
                    <div className="record-list">
                      {rows.map((t) => (
                        <article className="record-row" key={t.id}>
                          <strong>{t.title}</strong>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => editTask(t)}
                          >
                            Reopen
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </PageList>
              ) : (
                <Timeline
                  events={history.filter(
                    (e) =>
                      ["repair", "maintenance", "task"].includes(e.kind) &&
                      matches(`${e.summary} ${e.asset_name || ""}`),
                  )}
                  onAsset={onItem}
                />
              )}
            </>
          )}
          {view === "files" && (
            <>
              {uploadControl}
              <p className="panel-hint">PDF or text · 12 MB max</p>
              {searchBox("Find a file")}
              {files(home.documents)}
            </>
          )}
          {view === "memory" && (
            <>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => editMemory(null)}
              >
                <Icon name="plus" size={16} /> Add memory
              </button>
              {searchBox("Find a saved detail")}
              <PageList
                key={search}
                items={home.memories.filter((m) =>
                  matches(`${m.title} ${m.content}`),
                )}
                label="Memory"
                empty="Locations, preferences and contacts you ask HomeKeeper to remember appear here."
              >
                {(rows) => (
                  <div className="record-list">
                    {rows.map((m) => (
                      <article className="memory-row" key={m.id}>
                        {m.space_id && m.element_id ? (
                          <HomeSpatialCard
                            record={m}
                            revision={m.space_revision ?? m.linked_revision}
                            kind={m.kind === "location" ? "storage" : "object"}
                            title={m.title}
                            description={m.content}
                            storedItem={m.kind === "location" ? m.asset_name : null}
                            actionLabel="Show in Spaces"
                            onShowSpace={onShowSpace}
                          />
                        ) : (
                          <>
                            <h3>{m.title}</h3>
                            <p>{m.content}</p>
                          </>
                        )}
                        <div className="row-actions">
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => editMemory(m)}
                          >
                            Edit
                          </button>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => forget(m)}
                          >
                            Forget
                          </button>
                          <details>
                            <summary>Source</summary>
                            <p>{m.source}</p>
                          </details>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </PageList>
            </>
          )}
          {view === "timeline" && (
            <>
              {home.costs.length > 0 && (
                <p className="spending">
                  Recorded spending{" "}
                  <strong>
                    {home.costs.map((c) => c.amount_display).join(" · ")}
                  </strong>
                </p>
              )}
              {searchBox("Find past work")}
              <Timeline
                key={search}
                events={history.filter((e) =>
                  matches(
                    `${e.summary} ${e.asset_name || ""} ${e.detail || ""}`,
                  ),
                )}
                onAsset={onItem}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

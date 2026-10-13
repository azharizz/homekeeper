import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const currentDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "Asia/Jakarta",
  }).format(new Date());

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function withDisplayAmount(record) {
  if (!record.currency) return record;
  const format = new Intl.NumberFormat("en", {
    style: "currency",
    currency: record.currency,
    currencyDisplay: "code",
  });
  return {
    ...record,
    amount_display: format.format(
      (record.cost_minor ?? record.total_minor) /
        10 ** format.resolvedOptions().maximumFractionDigits,
    ),
  };
}

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, room TEXT NOT NULL, category TEXT NOT NULL,
      brand TEXT NOT NULL, model TEXT NOT NULL, serial TEXT NOT NULL,
      purchased_on TEXT, warranty_until TEXT, notes TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), title TEXT NOT NULL,
      kind TEXT NOT NULL, mime TEXT NOT NULL, original BLOB NOT NULL,
      pages TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_inbox (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
      original BLOB NOT NULL, pages TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maintenance (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), title TEXT NOT NULL,
      due_on TEXT, interval_days INTEGER, source TEXT NOT NULL, last_completed_on TEXT,
      revision INTEGER NOT NULL DEFAULT 1, space_id TEXT, element_id TEXT
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), symptom TEXT NOT NULL,
      opened_on TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','resolved')),
      resolved_on TEXT, cause TEXT, resolution TEXT, part TEXT, provider TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), kind TEXT NOT NULL,
      happened_on TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL,
      cost_minor INTEGER CHECK(cost_minor >= 0), currency TEXT, created_at TEXT NOT NULL,
      CHECK((cost_minor IS NULL AND currency IS NULL) OR (cost_minor IS NOT NULL AND currency IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS events_asset_date ON events(asset_id, happened_on);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, command TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);
    UPDATE operations SET command='save_home_item' WHERE command='save_appliance';
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
      asset_id TEXT REFERENCES assets(id), source TEXT NOT NULL, revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL, space_id TEXT, element_id TEXT
    );
    CREATE TABLE IF NOT EXISTS space_objects (
      space_id TEXT NOT NULL, element_id TEXT NOT NULL,
      asset_id TEXT NOT NULL REFERENCES assets(id),
      space_name TEXT NOT NULL, element_label TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(space_id, element_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, notes TEXT NOT NULL,
      asset_id TEXT REFERENCES assets(id), due_on TEXT, interval_days INTEGER,
      status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),
      last_completed_on TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      space_id TEXT, element_id TEXT
    );
    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL,
      completed_on TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const memoryColumns = db
    .prepare("PRAGMA table_info(memories)")
    .all()
    .map((column) => column.name);
  if (!memoryColumns.includes("space_id"))
    db.exec("ALTER TABLE memories ADD COLUMN space_id TEXT");
  if (!memoryColumns.includes("element_id"))
    db.exec("ALTER TABLE memories ADD COLUMN element_id TEXT");
  // Additive migration keeps existing plans and IDs intact.
  if (
    !db
      .prepare("PRAGMA table_info(maintenance)")
      .all()
      .some((column) => column.name === "revision")
  )
    db.exec(
      "ALTER TABLE maintenance ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    );
  for (const [table, column, type] of [
    ["maintenance", "space_id", "TEXT"],
    ["maintenance", "element_id", "TEXT"],
    ["maintenance", "space_revision", "INTEGER"],
    ["tasks", "space_id", "TEXT"],
    ["tasks", "element_id", "TEXT"],
    ["tasks", "space_revision", "INTEGER"],
    ["memories", "space_name", "TEXT"],
    ["memories", "element_label", "TEXT"],
    ["memories", "space_revision", "INTEGER"],
    ["space_objects", "revision", "INTEGER NOT NULL DEFAULT 1"],
  ]) {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((field) => field.name === column)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Snapshot legacy anchors once; later model-link updates must not move saved pins.
  db.exec(`
    UPDATE memories SET
      space_name=COALESCE(space_name,(SELECT space_name FROM space_objects s WHERE s.space_id=memories.space_id AND s.element_id=memories.element_id)),
      element_label=COALESCE(element_label,(SELECT element_label FROM space_objects s WHERE s.space_id=memories.space_id AND s.element_id=memories.element_id)),
      space_revision=COALESCE(space_revision,(SELECT revision FROM space_objects s WHERE s.space_id=memories.space_id AND s.element_id=memories.element_id))
    WHERE space_id IS NOT NULL AND (space_name IS NULL OR element_label IS NULL OR space_revision IS NULL);
    UPDATE tasks SET space_revision=(SELECT revision FROM space_objects s WHERE s.space_id=tasks.space_id AND s.element_id=tasks.element_id AND s.asset_id=tasks.asset_id)
    WHERE space_id IS NOT NULL AND space_revision IS NULL;
    UPDATE maintenance SET space_revision=(SELECT revision FROM space_objects s WHERE s.space_id=maintenance.space_id AND s.element_id=maintenance.element_id AND s.asset_id=maintenance.asset_id)
    WHERE space_id IS NOT NULL AND space_revision IS NULL;
  `);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const asset = (id) => {
    const found = one("SELECT * FROM assets WHERE id=?", id);
    if (!found)
      throw new UserError(
        "Home item not found. For a NEW item omit asset_id; for edits use the existing ID from get_home.",
        404,
      );
    return found;
  };
  const spatialLink = (spaceId, elementId, assetId, revision) => {
    const link = one(
      "SELECT * FROM space_objects WHERE space_id=? AND element_id=?",
      spaceId,
      elementId,
    );
    if (!link || link.asset_id !== assetId)
      throw new UserError(
        "Link this RoomTrace object to the same HomeKeeper item before pinning it.",
      );
    if (link.revision !== revision)
      throw new UserError(
        "This model link changed. Reconfirm the object link before pinning it.",
        409,
      );
    return link;
  };
  function currentRecord(table, id, revision) {
    const row = one(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row)
      throw new UserError(
        "Record not found. For a NEW memory or task omit its ID and expected_revision; for edits use the existing ID from get_home.",
        404,
      );
    if (row.revision !== revision)
      throw new UserError(
        "This record changed. Read it again before updating.",
        409,
      );
    return row;
  }
  function event(
    assetId,
    kind,
    date,
    summary,
    detail = "",
    cost = null,
    currency = null,
  ) {
    run(
      "INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      assetId,
      kind,
      date,
      summary,
      detail,
      cost,
      currency,
      new Date().toISOString(),
    );
  }
  function passport(id) {
    return {
      ...asset(id),
      documents: all(
        "SELECT id,title,kind,mime,created_at,json_array_length(pages) AS page_count FROM documents WHERE asset_id=? ORDER BY created_at",
        id,
      ),
      maintenance: all(
        `SELECT m.*,s.space_name,s.element_label,COALESCE(m.space_revision,s.revision) AS linked_revision
         FROM maintenance m LEFT JOIN space_objects s
           ON s.space_id=m.space_id AND s.element_id=m.element_id AND s.asset_id=m.asset_id
         WHERE m.asset_id=? ORDER BY m.due_on`,
        id,
      ),
      incidents: all(
        "SELECT * FROM incidents WHERE asset_id=? ORDER BY opened_on DESC",
        id,
      ),
      locations: all(
        `SELECT m.*,COALESCE(m.space_name,s.space_name) AS space_name,
           COALESCE(m.element_label,s.element_label) AS element_label,
           COALESCE(m.space_revision,s.revision) AS linked_revision
         FROM memories m LEFT JOIN space_objects s
           ON s.space_id=m.space_id AND s.element_id=m.element_id
         WHERE m.asset_id=? AND m.kind='location' ORDER BY m.updated_at DESC`,
        id,
      ),
      events: all(
        "SELECT * FROM events WHERE asset_id=? ORDER BY happened_on DESC,created_at DESC",
        id,
      ).map(withDisplayAmount),
      costs: all(
        "SELECT currency,SUM(cost_minor) AS total_minor FROM events WHERE asset_id=? AND cost_minor IS NOT NULL GROUP BY currency",
        id,
      ).map(withDisplayAmount),
    };
  }
  function home() {
    return {
      today: currentDate(),
      assets: all("SELECT * FROM assets ORDER BY room,name"),
      documents: all(
        `SELECT id,asset_id,title,kind,json_array_length(pages) AS page_count,created_at FROM documents
         UNION ALL SELECT id,NULL AS asset_id,title,kind,json_array_length(pages) AS page_count,created_at FROM document_inbox
         ORDER BY created_at DESC`,
      ),
      memories: all(
        `SELECT m.*,a.name AS asset_name,COALESCE(m.space_name,s.space_name) AS space_name,
           COALESCE(m.element_label,s.element_label) AS element_label,
           COALESCE(m.space_revision,s.revision) AS linked_revision
         FROM memories m LEFT JOIN assets a ON a.id=m.asset_id
         LEFT JOIN space_objects s ON s.space_id=m.space_id AND s.element_id=m.element_id
         ORDER BY m.updated_at DESC`,
      ),
      space_objects: all(
        "SELECT s.space_id,s.element_id,s.space_name,s.element_label,s.revision,s.asset_id,a.name AS asset_name,a.room FROM space_objects s JOIN assets a ON a.id=s.asset_id ORDER BY a.room,a.name",
      ),
      tasks: all(
        `SELECT t.*,s.space_name,s.element_label,COALESCE(t.space_revision,s.revision) AS linked_revision
         FROM tasks t LEFT JOIN space_objects s
           ON s.space_id=t.space_id AND s.element_id=t.element_id AND s.asset_id=t.asset_id
         ORDER BY t.status,t.due_on IS NULL,t.due_on,t.title`,
      ),
      task_history: all(
        "SELECT * FROM task_history ORDER BY completed_on DESC,created_at DESC",
      ),
      maintenance: all(
        `SELECT m.*,a.name AS asset_name,a.room,s.space_name,s.element_label,
           COALESCE(m.space_revision,s.revision) AS linked_revision
         FROM maintenance m JOIN assets a ON a.id=m.asset_id
         LEFT JOIN space_objects s ON s.space_id=m.space_id AND s.element_id=m.element_id AND s.asset_id=m.asset_id
         WHERE due_on IS NOT NULL ORDER BY due_on`,
      ),
      incidents: all(
        "SELECT i.*,a.name AS asset_name,a.room FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE status='open' ORDER BY opened_on DESC",
      ),
      events: all(
        "SELECT e.*,a.name AS asset_name FROM events e JOIN assets a ON a.id=e.asset_id ORDER BY happened_on DESC,created_at DESC",
      ).map(withDisplayAmount),
      costs: all(
        "SELECT currency,SUM(cost_minor) AS total_minor FROM events WHERE cost_minor IS NOT NULL GROUP BY currency",
      ).map(withDisplayAmount),
    };
  }
  const commands = {
    file_document(a) {
      asset(a.asset_id);
      const doc = one("SELECT * FROM document_inbox WHERE id=?", a.document_id);
      if (!doc)
        throw new UserError(
          "This document has already been filed or no longer exists. Read home records again.",
          409,
        );
      run(
        "INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)",
        doc.id,
        a.asset_id,
        a.title || doc.title,
        a.kind,
        doc.mime,
        doc.original,
        doc.pages,
        doc.created_at,
      );
      run("DELETE FROM document_inbox WHERE id=?", doc.id);
      return {
        id: doc.id,
        asset_id: a.asset_id,
        title: a.title || doc.title,
        kind: a.kind,
      };
    },
    save_home_item(a) {
      const id = a.asset_id || randomUUID();
      const exists = a.asset_id ? asset(id) : null;
      run(
        `INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,room=excluded.room,category=excluded.category,brand=excluded.brand,
        model=excluded.model,serial=excluded.serial,purchased_on=excluded.purchased_on,
        warranty_until=excluded.warranty_until,notes=excluded.notes`,
        id,
        a.name,
        a.room,
        a.category,
        a.brand,
        a.model,
        a.serial,
        a.purchased_on,
        a.warranty_until,
        a.notes,
        new Date().toISOString(),
      );
      event(
        id,
        "registration",
        currentDate(),
        exists ? "Passport updated" : "Home item added",
        a.name,
      );
      return passport(id);
    },
    link_space_object(a) {
      asset(a.asset_id);
      const prior = one(
        "SELECT * FROM space_objects WHERE space_id=? AND element_id=?",
        a.space_id,
        a.element_id,
      );
      if (prior && prior.asset_id !== a.asset_id)
        throw new UserError("This model object is already linked to another home item.", 409);
      if (prior && a.revision < prior.revision)
        throw new UserError("This model link changed. Refresh the model before linking.", 409);
      run(
        `INSERT INTO space_objects
          (space_id,element_id,asset_id,space_name,element_label,revision)
         VALUES (?,?,?,?,?,?) ON CONFLICT(space_id,element_id) DO UPDATE SET
          space_name=excluded.space_name,element_label=excluded.element_label,
          revision=excluded.revision`,
        a.space_id,
        a.element_id,
        a.asset_id,
        a.space_name,
        a.element_label,
        a.revision,
      );
      return one(
        "SELECT s.space_id,s.element_id,s.space_name,s.element_label,s.revision,s.asset_id,a.name AS asset_name FROM space_objects s JOIN assets a ON a.id=s.asset_id WHERE s.space_id=? AND s.element_id=?",
        a.space_id,
        a.element_id,
      );
    },
    resolve_spatial_location(a) {
      const prior = currentRecord("memories", a.memory_id, a.expected_revision);
      if (prior.kind !== "location" || !prior.asset_id)
        throw new UserError("Resolve a saved location attached to an existing home item.");
      return commands.save_memory({
        ...prior,
        ...a,
        asset_id: prior.asset_id,
      });
    },
    save_spatial_location(a) {
      return commands.save_memory(a);
    },
    save_memory(a) {
      const prior = a.memory_id
        ? currentRecord("memories", a.memory_id, a.expected_revision)
        : null;
      const storedItemId = a.asset_id === undefined ? (prior?.asset_id ?? null) : a.asset_id;
      if (storedItemId) asset(storedItemId);
      if (prior?.space_id && a.space_id === undefined &&
          (storedItemId !== prior.asset_id || a.kind !== "location"))
        throw new UserError("Use the household location UI to change a model-anchored location.");
      const spaceId = a.space_id === undefined ? (prior?.space_id ?? null) : a.space_id;
      const elementId =
        a.element_id === undefined ? (prior?.element_id ?? null) : a.element_id;
      if ((spaceId === null) !== (elementId === null))
        throw new UserError("A spatial location needs both a space and an object.");
      if (spaceId && (a.kind !== "location" || !storedItemId))
        throw new UserError(
          "A model pin requires a location memory attached to a home item.",
        );
      // The stored item is independent of the container's identity/passport link.
      const spaceRevision = spaceId
        ? (a.space_revision ?? prior?.space_revision ?? null) : null;
      const spaceName = spaceId
        ? (a.space_name ?? prior?.space_name ?? null) : null;
      const elementLabel = spaceId
        ? (a.element_label ?? prior?.element_label ?? null) : null;
      const id = a.memory_id || randomUUID();
      run(
        `INSERT INTO memories
          (id,title,content,kind,asset_id,source,revision,updated_at,space_id,element_id,space_name,element_label,space_revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,content=excluded.content,kind=excluded.kind,
          asset_id=excluded.asset_id,source=excluded.source,
          revision=excluded.revision,updated_at=excluded.updated_at,
          space_id=excluded.space_id,element_id=excluded.element_id,
          space_name=excluded.space_name,element_label=excluded.element_label,
          space_revision=excluded.space_revision`,
        id,
        a.title,
        a.content,
        a.kind,
        storedItemId,
        a.source,
        (prior?.revision || 0) + 1,
        new Date().toISOString(),
        spaceId,
        elementId,
        spaceName,
        elementLabel,
        spaceRevision,
      );
      return one("SELECT * FROM memories WHERE id=?", id);
    },
    forget_memory(a) {
      const prior = currentRecord("memories", a.memory_id, a.expected_revision);
      run("DELETE FROM memories WHERE id=?", prior.id);
      return {
        removed: prior.title,
        scope:
          "Saved memory only. Previous conversations and backups are unchanged.",
      };
    },
    save_spatial_task(a) {
      return commands.save_task(a);
    },
    save_task(a) {
      if (a.asset_id) asset(a.asset_id);
      const prior = a.task_id
        ? currentRecord("tasks", a.task_id, a.expected_revision)
        : null;
      const assetId = a.asset_id === undefined ? (prior?.asset_id ?? null) : a.asset_id;
      const explicitPin = a.space_id !== undefined ||
        a.element_id !== undefined || a.space_revision !== undefined;
      if (prior?.space_id && !explicitPin && assetId !== prior.asset_id)
        throw new UserError("Use the household object UI to change a model-pinned task's item.");
      const spaceRevision = a.space_id === null ? null :
        (explicitPin ? (a.space_revision ?? null) : (prior?.space_revision ?? null));
      const spaceId =
        a.space_id === undefined ? (prior?.space_id ?? null) : a.space_id;
      const elementId =
        a.element_id === undefined ? (prior?.element_id ?? null) : a.element_id;
      if ((spaceId === null) !== (elementId === null))
        throw new UserError("A model task needs both a space and an object.");
      if (spaceId && (explicitPin || !prior)) {
        if (!assetId)
          throw new UserError("A model task needs a linked home item.");
        spatialLink(spaceId, elementId, assetId, spaceRevision);
      }
      const id = a.task_id || randomUUID();
      run(
        `INSERT INTO tasks
          (id,title,kind,notes,asset_id,due_on,interval_days,status,last_completed_on,revision,created_at,space_id,element_id,space_revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,kind=excluded.kind,notes=excluded.notes,asset_id=excluded.asset_id,
          due_on=excluded.due_on,interval_days=excluded.interval_days,status=excluded.status,
          revision=excluded.revision,space_id=excluded.space_id,element_id=excluded.element_id,
          space_revision=excluded.space_revision`,
        id,
        a.title,
        a.kind,
        a.notes,
        assetId,
        a.due_on,
        a.interval_days,
        a.status,
        prior?.last_completed_on || null,
        (prior?.revision || 0) + 1,
        new Date().toISOString(),
        spaceId,
        elementId,
        spaceRevision,
      );
      return one("SELECT * FROM tasks WHERE id=?", id);
    },
    complete_task(a) {
      const task = currentRecord("tasks", a.task_id, a.expected_revision);
      if (task.status !== "open")
        throw new UserError("Only an open task can be completed.", 409);
      if (task.last_completed_on && a.completed_on < task.last_completed_on)
        throw new UserError("Completion cannot precede the last completion.");
      const next = new Date(`${a.completed_on}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + (task.interval_days || 0));
      run(
        "UPDATE tasks SET status=?,due_on=?,last_completed_on=?,revision=revision+1 WHERE id=?",
        task.interval_days ? "open" : "done",
        task.interval_days ? next.toISOString().slice(0, 10) : null,
        a.completed_on,
        task.id,
      );
      run(
        "INSERT INTO task_history VALUES (?,?,?,?,?,?)",
        randomUUID(),
        task.id,
        task.title,
        a.completed_on,
        a.notes,
        new Date().toISOString(),
      );
      return one("SELECT * FROM tasks WHERE id=?", task.id);
    },
    schedule_spatial_maintenance(a) {
      return commands.schedule_maintenance(a);
    },
    schedule_maintenance(a) {
      asset(a.asset_id);
      if (a.space_id) spatialLink(a.space_id, a.element_id, a.asset_id, a.space_revision);
      if ((a.space_id == null) !== (a.element_id == null))
        throw new UserError("A maintenance pin needs both a space and an object.");
      const id = randomUUID();
      run(
        "INSERT INTO maintenance(id,asset_id,title,due_on,interval_days,source,last_completed_on,space_id,element_id,space_revision) VALUES (?,?,?,?,?,?,NULL,?,?,?)",
        id,
        a.asset_id,
        a.title,
        a.due_on,
        a.interval_days,
        a.source,
        a.space_id || null,
        a.element_id || null,
        a.space_revision ?? null,
      );
      event(
        a.asset_id,
        "schedule",
        currentDate(),
        a.title,
        `Due ${a.due_on}. ${a.source}`,
      );
      return one("SELECT * FROM maintenance WHERE id=?", id);
    },
    update_maintenance(a) {
      const plan = one(
        "SELECT * FROM maintenance WHERE id=?",
        a.maintenance_id,
      );
      if (!plan) throw new UserError("Maintenance plan not found.", 404);
      if (
        plan.due_on !== a.expected_due_on ||
        plan.revision !== a.expected_revision
      )
        throw new UserError(
          "This plan changed. Read it again before updating.",
          409,
        );
      const explicitPin = a.space_id !== undefined ||
        a.element_id !== undefined || a.space_revision !== undefined;
      const spaceId = a.space_id === undefined ? plan.space_id : a.space_id;
      const elementId =
        a.element_id === undefined ? plan.element_id : a.element_id;
      const spaceRevision = a.space_id === null ? null :
        (explicitPin ? (a.space_revision ?? null) : (plan.space_revision ?? null));
      if ((spaceId === null) !== (elementId === null))
        throw new UserError("A maintenance pin needs both a space and an object.");
      if (spaceId && explicitPin)
        spatialLink(spaceId, elementId, plan.asset_id, spaceRevision);
      run(
        "UPDATE maintenance SET title=?,due_on=?,interval_days=?,source=?,revision=revision+1,space_id=?,element_id=?,space_revision=? WHERE id=?",
        a.title,
        a.due_on,
        a.interval_days,
        a.source,
        spaceId,
        elementId,
        spaceRevision,
        plan.id,
      );
      return one("SELECT * FROM maintenance WHERE id=?", plan.id);
    },
    complete_maintenance(a) {
      const task = one(
        "SELECT * FROM maintenance WHERE id=?",
        a.maintenance_id,
      );
      if (!task) throw new UserError("Maintenance task not found.", 404);
      if (task.due_on !== a.expected_due_on)
        throw new UserError(
          "This schedule has changed. Refresh before recording completion.",
          409,
        );
      if (task.last_completed_on && a.completed_on < task.last_completed_on)
        throw new UserError("Completion cannot precede the last completion.");
      const next = new Date(`${a.completed_on}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + (task.interval_days || 0));
      run(
        "UPDATE maintenance SET due_on=?,last_completed_on=?,revision=revision+1 WHERE id=?",
        task.interval_days ? next.toISOString().slice(0, 10) : null,
        a.completed_on,
        task.id,
      );
      event(
        task.asset_id,
        "maintenance",
        a.completed_on,
        task.title,
        a.notes,
        a.cost_minor,
        a.currency,
      );
      return passport(task.asset_id);
    },
    report_issue(a) {
      asset(a.asset_id);
      const id = randomUUID();
      run(
        "INSERT INTO incidents(id,asset_id,symptom,opened_on,status) VALUES (?,?,?,?,'open')",
        id,
        a.asset_id,
        a.symptom,
        a.opened_on,
      );
      event(a.asset_id, "issue", a.opened_on, a.symptom);
      return one("SELECT * FROM incidents WHERE id=?", id);
    },
    resolve_issue(a) {
      const issue = one("SELECT * FROM incidents WHERE id=?", a.incident_id);
      if (!issue) throw new UserError("Issue not found.", 404);
      if (issue.status === "resolved")
        throw new UserError("This issue is already resolved.", 409);
      if (a.resolved_on < issue.opened_on)
        throw new UserError("Resolution cannot precede the issue.");
      run(
        "UPDATE incidents SET status='resolved',resolved_on=?,cause=?,resolution=?,part=?,provider=? WHERE id=?",
        a.resolved_on,
        a.cause,
        a.resolution,
        a.part,
        a.provider,
        issue.id,
      );
      const detail = Object.entries({
        symptom: issue.symptom,
        cause: a.cause,
        part: a.part,
        provider: a.provider,
      })
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" · ");
      event(
        issue.asset_id,
        "repair",
        a.resolved_on,
        a.resolution,
        detail,
        a.cost_minor,
        a.currency,
      );
      return passport(issue.asset_id);
    },
    record_history(a) {
      asset(a.asset_id);
      event(
        a.asset_id,
        a.kind,
        a.happened_on,
        a.summary,
        a.detail,
        a.cost_minor,
        a.currency,
      );
      return passport(a.asset_id);
    },
  };
  function mutate(name, args, requestId) {
    const input = JSON.stringify(args);
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = one("SELECT * FROM operations WHERE id=?", requestId);
      if (prior) {
        if (prior.command !== name || prior.input !== input)
          throw new UserError(
            "This request ID was already used for different data.",
            409,
          );
        db.exec("COMMIT");
        return JSON.parse(prior.result);
      }
      const result = commands[name](args);
      run(
        "INSERT INTO operations VALUES (?,?,?,?)",
        requestId,
        name,
        input,
        JSON.stringify(result),
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function addDocument(assetId, title, kind, mime, original, pages) {
    if (assetId) asset(assetId);
    const id = randomUUID();
    const values = [
      id,
      title,
      kind,
      mime,
      original,
      JSON.stringify(pages),
      new Date().toISOString(),
    ];
    if (assetId) values.splice(1, 0, assetId);
    run(
      assetId
        ? "INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)"
        : "INSERT INTO document_inbox VALUES (?,?,?,?,?,?,?)",
      ...values,
    );
    return { id, asset_id: assetId, title, kind, page_count: pages.length };
  }
  function document(id) {
    const doc =
      one("SELECT * FROM documents WHERE id=?", id) ||
      one("SELECT *,NULL AS asset_id FROM document_inbox WHERE id=?", id);
    if (!doc) throw new UserError("Document not found.", 404);
    return doc;
  }
  function readDocument(id, page, offset = 0) {
    const doc = document(id);
    const pages = JSON.parse(doc.pages);
    if (page > pages.length)
      throw new UserError(`Document has ${pages.length} pages.`);
    const fullText = pages[page - 1];
    if (offset > fullText.length)
      throw new UserError("Offset exceeds this page.");
    const end = Math.min(offset + 16000, fullText.length);
    return {
      id,
      title: doc.title,
      asset_id: doc.asset_id,
      page_count: pages.length,
      pages: [{ page, offset, text: fullText.slice(offset, end) }],
      next:
        end < fullText.length
          ? { page, offset: end }
          : page < pages.length
            ? { page: page + 1, offset: 0 }
            : null,
      source: `/api/documents/${id}/download`,
    };
  }
  return {
    db,
    home,
    passport,
    mutate,
    addDocument,
    document,
    readDocument,
    close: () => db.close(),
  };
}

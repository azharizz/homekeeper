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
      due_on TEXT, interval_days INTEGER, source TEXT NOT NULL, last_completed_on TEXT, revision INTEGER NOT NULL DEFAULT 1
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
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, notes TEXT NOT NULL,
      asset_id TEXT REFERENCES assets(id), due_on TEXT, interval_days INTEGER,
      status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),
      last_completed_on TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL,
      completed_on TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
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
        "SELECT * FROM maintenance WHERE asset_id=? ORDER BY due_on",
        id,
      ),
      incidents: all(
        "SELECT * FROM incidents WHERE asset_id=? ORDER BY opened_on DESC",
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
      memories: all("SELECT * FROM memories ORDER BY updated_at DESC"),
      tasks: all(
        "SELECT * FROM tasks ORDER BY status,due_on IS NULL,due_on,title",
      ),
      task_history: all(
        "SELECT * FROM task_history ORDER BY completed_on DESC,created_at DESC",
      ),
      maintenance: all(
        "SELECT m.*,a.name AS asset_name,a.room FROM maintenance m JOIN assets a ON a.id=m.asset_id WHERE due_on IS NOT NULL ORDER BY due_on",
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
    save_memory(a) {
      if (a.asset_id) asset(a.asset_id);
      const prior = a.memory_id
        ? currentRecord("memories", a.memory_id, a.expected_revision)
        : null;
      const id = a.memory_id || randomUUID();
      run(
        `INSERT INTO memories VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,content=excluded.content,kind=excluded.kind,asset_id=excluded.asset_id,
        source=excluded.source,revision=excluded.revision,updated_at=excluded.updated_at`,
        id,
        a.title,
        a.content,
        a.kind,
        a.asset_id,
        a.source,
        (prior?.revision || 0) + 1,
        new Date().toISOString(),
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
    save_task(a) {
      if (a.asset_id) asset(a.asset_id);
      const prior = a.task_id
        ? currentRecord("tasks", a.task_id, a.expected_revision)
        : null;
      const id = a.task_id || randomUUID();
      run(
        `INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,kind=excluded.kind,notes=excluded.notes,asset_id=excluded.asset_id,
        due_on=excluded.due_on,interval_days=excluded.interval_days,status=excluded.status,
        revision=excluded.revision`,
        id,
        a.title,
        a.kind,
        a.notes,
        a.asset_id,
        a.due_on,
        a.interval_days,
        a.status,
        prior?.last_completed_on || null,
        (prior?.revision || 0) + 1,
        new Date().toISOString(),
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
    schedule_maintenance(a) {
      asset(a.asset_id);
      const id = randomUUID();
      run(
        "INSERT INTO maintenance(id,asset_id,title,due_on,interval_days,source,last_completed_on) VALUES (?,?,?,?,?,?,NULL)",
        id,
        a.asset_id,
        a.title,
        a.due_on,
        a.interval_days,
        a.source,
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
      run(
        "UPDATE maintenance SET title=?,due_on=?,interval_days=?,source=?,revision=revision+1 WHERE id=?",
        a.title,
        a.due_on,
        a.interval_days,
        a.source,
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

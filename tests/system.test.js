import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../capability/store.js";
import { execute, executeUiAction, tools } from "../capability/tools.js";
import { createCapability } from "../capability/server.js";
import { createHost } from "../alexa_host/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function textPdf(text) {
  const stream = `BT /F1 12 Tf 40 740 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("real lifecycle, persistence, HTTP boundaries, uploads and MCP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "homekeeper-test-"));
  const path = join(directory, "home.sqlite");
  const token = randomUUID() + randomUUID();
  let store = openStore(path);
  let capabilityServer, hostServer, roomtraceServer, capability, host, client;
  try {
    assert.equal(store.home().assets.length, 0, "No fake household is seeded");
    const request_id = randomUUID();
    const input = {
      name: "TEST appliance",
      room: "Test room",
      category: "Dishwasher",
      model: "TEST-ONLY",
      request_id,
    };
    const asset = execute(store, "save_appliance", input);
    assert.equal(
      execute(store, "save_appliance", input).id,
      asset.id,
      "Identical retries deduplicate",
    );
    assert.throws(
      () => execute(store, "save_appliance", { ...input, name: "Different" }),
      /different data/,
    );
    assert.equal(store.home().assets.length, 1);
    assert.throws(() =>
      execute(store, "save_appliance", {
        ...input,
        request_id: randomUUID(),
        purchased_on: "2025-02-30",
      }),
    );
    assert.throws(
      () =>
        execute(store, "save_appliance", {
          ...input,
          request_id: randomUUID(),
          purchased_on: "2025-02-28",
          warranty_until: "2025-02-01",
        }),
      /precede/,
    );
    const issue = execute(store, "report_issue", {
      asset_id: asset.id,
      symptom: "TEST ONLY leak",
      opened_on: "2025-02-12",
    });
    assert.equal(store.home().incidents.length, 1);
    assert.throws(
      () =>
        execute(store, "resolve_issue", {
          incident_id: issue.id,
          resolved_on: "2025-02-11",
          resolution: "invalid",
        }),
      /precede/,
    );
    const repair = {
      incident_id: issue.id,
      resolved_on: "2025-02-13",
      resolution: "TEST ONLY hose replaced",
      part: "TEST part",
      provider: "Test fixture",
      cost_minor: 8250,
      currency: "USD",
      request_id: randomUUID(),
    };
    execute(store, "resolve_issue", repair);
    execute(store, "resolve_issue", repair);
    assert.equal(store.home().incidents.length, 0);
    assert.equal(
      store.passport(asset.id).costs[0].total_minor,
      8250,
      "No duplicate charge",
    );
    assert.match(
      store.passport(asset.id).costs[0].amount_display,
      /USD.*82\.50/,
    );
    assert.match(
      store.home().events.find((e) => e.kind === "repair").amount_display,
      /USD.*82\.50/,
    );
    assert.equal(
      store.passport(asset.id).events.filter((e) => e.kind === "repair").length,
      1,
    );
    assert.throws(
      () =>
        execute(store, "resolve_issue", {
          ...repair,
          request_id: randomUUID(),
        }),
      /already resolved/,
    );
    assert.throws(
      () =>
        execute(store, "record_history", {
          asset_id: asset.id,
          kind: "repair",
          happened_on: "2025-02-14",
          summary: "Invalid money",
          cost_minor: 1,
        }),
      /together/,
    );
    assert.throws(() =>
      execute(store, "record_history", {
        asset_id: asset.id,
        kind: "repair",
        happened_on: "2025-02-14",
        summary: "Invalid money",
        cost_minor: -1,
        currency: "USD",
      }),
    );
    execute(store, "record_history", {
      asset_id: asset.id,
      kind: "repair",
      happened_on: "2025-02-14",
      summary: "Other currency",
      cost_minor: 100000,
      currency: "IDR",
      detail: "{user text is not JSON",
    });
    assert.equal(
      store.passport(asset.id).costs.length,
      2,
      "Currencies never combine",
    );
    const schedule = execute(store, "schedule_maintenance", {
      asset_id: asset.id,
      title: "TEST ONLY clean filter",
      due_on: "2024-02-28",
      interval_days: 2,
      source: "Explicit test input",
    });
    const completion = {
      maintenance_id: schedule.id,
      expected_due_on: "2024-02-28",
      completed_on: "2024-02-28",
      notes: "Done",
      request_id: randomUUID(),
    };
    execute(store, "complete_maintenance", completion);
    execute(store, "complete_maintenance", completion);
    assert.equal(
      store.passport(asset.id).maintenance[0].due_on,
      "2024-03-01",
      "Leap day handled",
    );
    assert.throws(
      () =>
        execute(store, "complete_maintenance", {
          ...completion,
          request_id: randomUUID(),
        }),
      /changed/,
    );
    const oneOff = execute(store, "schedule_maintenance", {
      asset_id: asset.id,
      title: "One time",
      due_on: "2025-03-01",
      source: "Explicit test input",
    });
    execute(store, "complete_maintenance", {
      maintenance_id: oneOff.id,
      expected_due_on: "2025-03-01",
      completed_on: "2025-03-01",
    });
    assert.equal(
      store.home().maintenance.length,
      1,
      "Completed one-time task leaves active queue",
    );
    assert.throws(
      () =>
        execute(store, "report_issue", {
          asset_id: randomUUID(),
          symptom: "Invalid FK",
          opened_on: "2025-01-01",
        }),
      /not found/,
    );
    const plant = execute(store, "save_home_item", {
      name: "TEST fern",
      category: "plant",
    });
    const remembered = execute(store, "save_memory", {
      title: "Spare key",
      content: "Blue drawer",
      kind: "location",
      source: "My spare key is in the blue drawer.",
    });
    const corrected = execute(store, "save_memory", {
      memory_id: remembered.id,
      expected_revision: remembered.revision,
      title: "Spare key",
      content: "Green drawer",
      kind: "location",
      source: "Correction: green drawer.",
    });
    assert.equal(corrected.revision, 2);
    assert.equal(
      store.home().memories.length,
      1,
      "Corrections update rather than duplicate",
    );
    assert.throws(
      () =>
        execute(store, "save_memory", {
          memory_id: remembered.id,
          expected_revision: 1,
          title: "Spare key",
          content: "Stale",
          kind: "location",
          source: "Stale tab",
        }),
      /changed/,
    );
    assert.throws(
      () =>
        execute(store, "forget_memory", {
          memory_id: remembered.id,
          expected_revision: 1,
        }),
      /changed/,
    );
    const routine = execute(store, "save_task", {
      title: "Water fern",
      kind: "routine",
      asset_id: plant.id,
      due_on: "2024-02-28",
      interval_days: 2,
    });
    const done = {
      task_id: routine.id,
      expected_revision: routine.revision,
      completed_on: "2024-02-28",
      request_id: randomUUID(),
    };
    assert.equal(execute(store, "complete_task", done).due_on, "2024-03-01");
    execute(store, "complete_task", done);
    assert.equal(
      store.home().task_history.length,
      1,
      "Completion retry keeps one historical record",
    );
    assert.throws(
      () =>
        execute(store, "complete_task", { ...done, request_id: randomUUID() }),
      /changed/,
    );
    const shopping = execute(store, "save_task", {
      title: "Buy compost",
      kind: "shopping",
    });
    assert.equal(shopping.due_on, null, "Tasks need no invented date");
    assert.equal(
      execute(store, "complete_task", {
        task_id: shopping.id,
        expected_revision: shopping.revision,
        completed_on: "2025-01-01",
      }).status,
      "done",
    );
    assert.throws(
      () =>
        execute(store, "save_task", {
          title: "Missing date",
          kind: "routine",
          interval_days: 2,
        }),
      /due date/,
    );
    assert.throws(
      () =>
        execute(store, "save_memory", {
          title: "Invalid item",
          content: "x",
          kind: "fact",
          source: "x",
          asset_id: randomUUID(),
        }),
      /not found/,
    );
    const cancelled = execute(store, "save_task", {
      task_id: routine.id,
      expected_revision: 2,
      title: routine.title,
      kind: routine.kind,
      status: "cancelled",
    });
    assert.equal(cancelled.status, "cancelled");
    assert.throws(
      () =>
        execute(store, "complete_task", {
          task_id: routine.id,
          expected_revision: 3,
          completed_on: "2025-01-01",
        }),
      /open task/,
    );
    const priorPlans = store.db
      .prepare("SELECT id,title,due_on FROM maintenance ORDER BY id")
      .all();
    store.db.exec("ALTER TABLE maintenance DROP COLUMN revision");
    store.close();
    store = openStore(path);
    assert.deepEqual(
      store.db
        .prepare("SELECT id,title,due_on FROM maintenance ORDER BY id")
        .all(),
      priorPlans,
      "Legacy maintenance migration preserves records",
    );
    assert.ok(
      store.db
        .prepare("SELECT revision FROM maintenance")
        .all()
        .every((m) => m.revision === 1),
    );
    assert.equal(
      store.passport(asset.id).incidents[0].status,
      "resolved",
      "Facts survive a reopen",
    );
    assert.equal(
      store.home().memories[0].content,
      "Green drawer",
      "Memory survives reopen",
    );
    assert.equal(store.home().task_history.length, 2);
    execute(store, "forget_memory", {
      memory_id: remembered.id,
      expected_revision: corrected.revision,
    });
    assert.equal(store.home().memories.length, 0);
    const storageItem = execute(store, "save_home_item", {
      name: "TEST key box",
      category: "storage",
    });
    const spaceId = "a".repeat(32);
    const elementId = "cabinet_1";
    const linkInput = {
      space_id: spaceId,
      element_id: elementId,
      asset_id: storageItem.id,
      space_name: "TEST room",
      element_label: "TEST cabinet",
      revision: 1,
      request_id: randomUUID(),
    };
    const modelLink = executeUiAction(store, "link_space_object", linkInput);
    assert.equal(modelLink.asset_id, storageItem.id);
    assert.equal(tools.link_space_object, undefined);
    assert.throws(
      () => execute(store, "link_space_object", linkInput),
      /Unknown tool/,
      "Model clients cannot invent UI-confirmed object links",
    );
    assert.throws(
      () =>
        executeUiAction(store, "link_space_object", {
          ...linkInput,
          request_id: randomUUID(),
          asset_id: asset.id,
        }),
      /already linked/,
    );
    const modelLocation = executeUiAction(store, "save_spatial_location", {
      title: "TEST key box location",
      content: "Inside the lower cabinet",
      kind: "location",
      source: "Explicit test household statement",
      asset_id: storageItem.id,
      space_id: spaceId,
      element_id: elementId,
      space_revision: 1,
      space_name: "TEST room",
      element_label: "TEST cabinet",
    });
    assert.equal(store.passport(storageItem.id).locations[0].space_name, "TEST room");
    assert.equal(
      store.passport(storageItem.id).locations[0].element_label,
      "TEST cabinet",
    );
    const correctedLocation = execute(store, "save_memory", {
      memory_id: modelLocation.id,
      expected_revision: modelLocation.revision,
      title: modelLocation.title,
      content: "Inside the top drawer",
      kind: "location",
      source: "Test correction",
    });
    assert.equal(correctedLocation.space_id, spaceId);
    assert.equal(correctedLocation.element_id, elementId);
    assert.equal(correctedLocation.asset_id, storageItem.id);
    assert.equal(correctedLocation.space_revision, 1);
    assert.equal(correctedLocation.content, "Inside the top drawer");
    const otherItemLocation = executeUiAction(store, "save_spatial_location", {
      title: "TEST separate stored thing",
      content: "Left drawer",
      kind: "location",
      source: "Test explicit selection",
      asset_id: asset.id,
      space_id: spaceId,
      element_id: elementId,
      space_revision: 1,
      space_name: "TEST room",
      element_label: "TEST cabinet",
    });
    assert.equal(otherItemLocation.asset_id, asset.id);
    assert.equal(store.passport(asset.id).locations[0].element_label, "TEST cabinet");
    assert.throws(
      () => execute(store, "save_memory", { ...otherItemLocation, source: "Test" }),
      /Unrecognized/,
      "Agent memory writes cannot supply model anchors",
    );
    const spatialTaskInput = {
      title: "TEST inspect cabinet",
      kind: "task",
      notes: "",
      asset_id: storageItem.id,
      due_on: "2025-01-01",
      space_id: spaceId,
      element_id: elementId,
      space_revision: 1,
    };
    assert.throws(() => execute(store, "save_task", spatialTaskInput), /Unrecognized/);
    assert.throws(
      () => execute(store, "save_spatial_task", spatialTaskInput),
      /Unknown tool/,
    );
    assert.throws(
      () => executeUiAction(store, "save_spatial_task", {
        ...spatialTaskInput, space_revision: 2,
      }),
      /model link changed/,
      "A new pin needs the revision of the human-confirmed link",
    );
    assert.throws(
      () => executeUiAction(store, "save_spatial_task", {
        ...spatialTaskInput, asset_id: asset.id,
      }),
      /same HomeKeeper item/,
    );
    const spatialTask = executeUiAction(store, "save_spatial_task", spatialTaskInput);
    assert.equal(spatialTask.space_id, spaceId);
    assert.equal(
      store.home().tasks.find((task) => task.id === spatialTask.id).element_label,
      "TEST cabinet",
    );
    const spatialPlanInput = {
      asset_id: storageItem.id,
      title: "TEST clean cabinet",
      due_on: "2025-01-02",
      interval_days: 30,
      source: "TEST user-provided schedule",
      space_id: spaceId,
      element_id: elementId,
      space_revision: 1,
    };
    assert.throws(
      () => execute(store, "schedule_maintenance", spatialPlanInput),
      /Unrecognized/,
    );
    assert.throws(
      () => execute(store, "schedule_spatial_maintenance", spatialPlanInput),
      /Unknown tool/,
    );
    assert.throws(
      () => executeUiAction(store, "schedule_spatial_maintenance", {
        ...spatialPlanInput, space_revision: 2,
      }),
      /model link changed/,
    );
    const spatialPlan = executeUiAction(store, "schedule_spatial_maintenance", spatialPlanInput);
    executeUiAction(store, "link_space_object", {
      ...linkInput, revision: 2, request_id: randomUUID(),
    });
    for (const [name, input] of [
      ["save_spatial_task", spatialTaskInput],
      ["schedule_spatial_maintenance", spatialPlanInput],
    ]) {
      assert.throws(
        () => executeUiAction(store, name, input),
        (error) => error.status === 409 && /model link changed/.test(error.message),
        "The old revision cannot create new pins after link reconfirmation",
      );
    }
    const editedSpatialTask = execute(store, "save_task", {
      task_id: spatialTask.id,
      expected_revision: spatialTask.revision,
      title: "TEST revised cabinet task",
      kind: spatialTask.kind,
      notes: "TEST changed notes",
      due_on: "2025-02-01",
      status: "cancelled",
    });
    assert.equal(editedSpatialTask.space_id, spaceId);
    assert.equal(editedSpatialTask.element_id, elementId);
    assert.equal(editedSpatialTask.asset_id, storageItem.id);
    assert.equal(editedSpatialTask.space_revision, 1);
    assert.equal(editedSpatialTask.status, "cancelled");
    const reopenedSpatialTask = execute(store, "save_task", {
      task_id: spatialTask.id,
      expected_revision: editedSpatialTask.revision,
      title: editedSpatialTask.title,
      kind: editedSpatialTask.kind,
      notes: editedSpatialTask.notes,
      due_on: editedSpatialTask.due_on,
      status: "open",
    });
    assert.equal(reopenedSpatialTask.space_revision, 1);
    assert.equal(reopenedSpatialTask.status, "open");
    assert.throws(
      () => executeUiAction(store, "save_spatial_task", {
        ...spatialTaskInput,
        task_id: spatialTask.id,
        expected_revision: reopenedSpatialTask.revision,
      }),
      /model link changed/,
      "Explicit re-pins still require the current link revision",
    );
    const repinnedSpatialTask = executeUiAction(store, "save_spatial_task", {
      ...spatialTaskInput,
      task_id: spatialTask.id,
      expected_revision: reopenedSpatialTask.revision,
      space_revision: 2,
    });
    assert.equal(repinnedSpatialTask.space_revision, 2);
    const updatedSpatialPlan = execute(store, "update_maintenance", {
      maintenance_id: spatialPlan.id,
      expected_due_on: spatialPlan.due_on,
      expected_revision: spatialPlan.revision,
      title: "TEST revised cabinet maintenance",
      due_on: "2025-02-02",
      interval_days: spatialPlan.interval_days,
      source: spatialPlan.source,
    });
    assert.equal(updatedSpatialPlan.space_id, spaceId);
    assert.equal(updatedSpatialPlan.element_id, elementId);
    assert.equal(updatedSpatialPlan.space_revision, 1);
    const stoppedSpatialPlan = execute(store, "update_maintenance", {
      maintenance_id: spatialPlan.id,
      expected_due_on: updatedSpatialPlan.due_on,
      expected_revision: updatedSpatialPlan.revision,
      title: updatedSpatialPlan.title,
      due_on: null,
      interval_days: null,
      source: updatedSpatialPlan.source,
    });
    assert.equal(stoppedSpatialPlan.space_id, spaceId);
    assert.equal(stoppedSpatialPlan.element_id, elementId);
    assert.equal(stoppedSpatialPlan.space_revision, 1);
    assert.equal(stoppedSpatialPlan.due_on, null);
    assert.throws(
      () => execute(store, "update_maintenance", {
        maintenance_id: spatialPlan.id,
        expected_due_on: updatedSpatialPlan.due_on,
        expected_revision: updatedSpatialPlan.revision,
        title: updatedSpatialPlan.title,
        due_on: updatedSpatialPlan.due_on,
        interval_days: updatedSpatialPlan.interval_days,
        source: updatedSpatialPlan.source,
        space_id: spaceId,
        element_id: elementId,
        space_revision: 2,
      }),
      /Unrecognized/,
      "Agent maintenance edits cannot set or replace a model anchor",
    );
    assert.equal(
      store.passport(storageItem.id).maintenance[0].element_label,
      "TEST cabinet",
    );
    store.close();
    store = null;
    capability = createCapability({ path, token });
    capabilityServer = capability.app.listen(0, "127.0.0.1");
    await once(capabilityServer, "listening");
    const capabilityUrl = `http://127.0.0.1:${capabilityServer.address().port}`;
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${capabilityUrl}/api/home`)).status, 401);
    assert.equal(
      (
        await fetch(`${capabilityUrl}/api/home`, {
          headers: { ...auth, Origin: "https://attacker.invalid" },
        })
      ).status,
      403,
    );
    client = new Client({ name: "HomeKeeper verification", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${capabilityUrl}/mcp`), {
        requestInit: { headers: auth },
      }),
      { timeout: 900000 },
    );
    const discovery = await client.listTools();
    assert.equal(discovery.tools.length, 15);
    assert.ok(discovery.tools.some((t) => t.name === "save_home_item"));
    assert.ok(!discovery.tools.some((t) => t.name === "save_appliance"));
    assert.ok(!discovery.tools.some((t) => t.name === "link_space_object"));
    assert.ok(!discovery.tools.some((t) => t.name === "save_spatial_location"));
    for (const name of ["save_spatial_task", "schedule_spatial_maintenance"])
      assert.ok(!discovery.tools.some((t) => t.name === name));
    for (const name of ["save_task", "schedule_maintenance", "update_maintenance"]) {
      const properties = discovery.tools.find((t) => t.name === name).inputSchema.properties;
      for (const field of ["space_id", "element_id", "space_revision"])
        assert.ok(!(field in properties));
    }
    assert.ok(!("space_id" in discovery.tools.find((t) => t.name === "save_memory").inputSchema.properties));
    assert.equal(
      discovery.tools.find((t) => t.name === "get_home").annotations
        .readOnlyHint,
      true,
    );
    assert.equal(
      discovery.tools.find((t) => t.name === "resolve_issue").annotations
        .readOnlyHint,
      false,
    );
    const result = await client.callTool({
      name: "get_passport",
      arguments: { asset_id: asset.id },
    });
    assert.equal(result.structuredContent.model, "TEST-ONLY");
    assert.equal(
      result.structuredContent.incidents[0].resolution,
      "TEST ONLY hose replaced",
    );
    const invalid = await client.callTool({
      name: "get_passport",
      arguments: { asset_id: randomUUID() },
    });
    assert.equal(invalid.isError, true);
    const form = new FormData();
    form.set("title", "Test document");
    form.set("kind", "manual");
    form.set(
      "file",
      new Blob(["TEST ONLY document. Clean the removable filter."]),
      "test.txt",
    );
    const uploaded = await fetch(
      `${capabilityUrl}/api/assets/${asset.id}/documents`,
      { method: "POST", headers: auth, body: form },
    );
    assert.equal(uploaded.status, 201);
    const doc = await uploaded.json();
    const source = await client.callTool({
      name: "read_document",
      arguments: { document_id: doc.id, page: 1 },
    });
    assert.equal(source.structuredContent.pages[0].page, 1);
    assert.match(source.structuredContent.pages[0].text, /TEST ONLY/);
    assert.equal(
      (
        await fetch(`${capabilityUrl}/api/documents/${doc.id}/download`, {
          headers: auth,
        })
      ).headers
        .get("content-disposition")
        .startsWith("attachment"),
      true,
    );
    const inboxForm = new FormData();
    inboxForm.set(
      "file",
      new Blob(["TEST ONLY receipt. Exact model INTAKE-42."]),
      "receipt.txt",
    );
    const inboxResponse = await fetch(`${capabilityUrl}/api/documents`, {
      method: "POST",
      headers: auth,
      body: inboxForm,
    });
    assert.equal(inboxResponse.status, 201);
    const intake = await inboxResponse.json();
    assert.equal(intake.title, "receipt.txt", "Upload needs no title form");
    assert.equal(intake.asset_id, null);
    assert.match(
      capability.store.readDocument(intake.id, 1).pages[0].text,
      /INTAKE-42/,
    );
    const fileArgs = {
      document_id: intake.id,
      asset_id: asset.id,
      kind: "receipt",
      request_id: randomUUID(),
    };
    const filed = execute(capability.store, "file_document", fileArgs);
    assert.equal(filed.id, intake.id, "Filing preserves the source ID");
    assert.deepEqual(
      execute(capability.store, "file_document", fileArgs),
      filed,
      "A filing retry is idempotent",
    );
    assert.equal(
      capability.store.home().documents.filter((d) => d.id === intake.id)
        .length,
      1,
    );
    assert.equal(
      capability.store.readDocument(intake.id, 1).asset_id,
      asset.id,
    );
    assert.equal(
      capability.store
        .passport(asset.id)
        .documents.some((d) => d.id === intake.id),
      true,
    );
    assert.throws(
      () =>
        execute(capability.store, "file_document", {
          ...fileArgs,
          request_id: randomUUID(),
        }),
      /already been filed/,
    );
    const unfiled = capability.store.addDocument(
      null,
      "Keep original",
      "other",
      "text/plain",
      Buffer.from("original"),
      ["original"],
    );
    const plan = execute(capability.store, "schedule_maintenance", {
      asset_id: asset.id,
      title: "TEST care",
      due_on: "2030-01-01",
      source: "Test household schedule",
    });
    const planEdit = {
      maintenance_id: plan.id,
      expected_due_on: plan.due_on,
      expected_revision: plan.revision,
      title: "TEST revised care",
      due_on: "2030-02-01",
      interval_days: 90,
      source: "User changed schedule",
      request_id: randomUUID(),
    };
    execute(capability.store, "update_maintenance", planEdit);
    assert.throws(
      () =>
        execute(capability.store, "update_maintenance", {
          ...planEdit,
          request_id: randomUUID(),
        }),
      /changed/,
    );
    assert.equal(
      capability.store.home().maintenance.find((m) => m.id === plan.id).due_on,
      "2030-02-01",
    );
    execute(capability.store, "update_maintenance", {
      ...planEdit,
      expected_due_on: "2030-02-01",
      expected_revision: 2,
      due_on: null,
      interval_days: null,
      request_id: randomUUID(),
    });
    assert.equal(
      capability.store.home().maintenance.some((m) => m.id === plan.id),
      false,
      "Stopped care retains its passport record but leaves active work",
    );
    const invalidUpload = new FormData();
    invalidUpload.set("title", "Bad");
    invalidUpload.set("kind", "manual");
    invalidUpload.set("file", new Blob(["not a pdf"]), "bad.pdf");
    assert.equal(
      (
        await fetch(`${capabilityUrl}/api/assets/${asset.id}/documents`, {
          method: "POST",
          headers: auth,
          body: invalidUpload,
        })
      ).status,
      400,
    );
    const invalidJson = await fetch(
      `${capabilityUrl}/api/actions/save_appliance`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: "{broken",
      },
    );
    assert.equal(invalidJson.status, 400);
    const exported = await (
      await fetch(`${capabilityUrl}/api/export`, { headers: auth })
    ).json();
    assert.equal(
      Buffer.from(exported.documents[0].original_base64, "base64").toString(),
      "TEST ONLY document. Clean the removable filter.",
    );
    assert.equal(JSON.stringify(exported).includes(token), false);
    assert.equal(
      Buffer.from(
        exported.documents.find((d) => d.id === unfiled.id).original_base64,
        "base64",
      ).toString(),
      "original",
      "Export includes unfiled originals",
    );
    const pdfUpload = new FormData();
    pdfUpload.set("title", "PDF extraction test");
    pdfUpload.set("kind", "manual");
    pdfUpload.set(
      "file",
      new Blob([textPdf("TEST ONLY searchable PDF instructions")], {
        type: "application/pdf",
      }),
      "test.pdf",
    );
    const pdfResponse = await fetch(
      `${capabilityUrl}/api/assets/${asset.id}/documents`,
      { method: "POST", headers: auth, body: pdfUpload },
    );
    const pdfDocument = await pdfResponse.json();
    assert.equal(pdfResponse.status, 201, JSON.stringify(pdfDocument));
    assert.match(
      capability.store.readDocument(pdfDocument.id, 1).pages[0].text,
      /searchable PDF instructions/,
    );
    const longText = "x".repeat(17000);
    const longDoc = capability.store.addDocument(
      asset.id,
      "Long test",
      "manual",
      "text/plain",
      Buffer.from(longText),
      [longText],
    );
    const firstPage = capability.store.readDocument(longDoc.id, 1);
    assert.equal(firstPage.pages[0].text.length, 16000);
    assert.deepEqual(firstPage.next, { page: 1, offset: 16000 });
    assert.equal(
      capability.store.readDocument(longDoc.id, 1, firstPage.next.offset)
        .pages[0].text.length,
      1000,
    );
    let roomtraceRevision = 1;
    let roomtraceStatus = 200;
    let roomtraceRequests = 0;
    roomtraceServer = createServer((req, res) => {
      roomtraceRequests++;
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.url, `/api/maps/${spaceId}/architecture`);
      res.writeHead(roomtraceStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ revision: roomtraceRevision, document: {} }));
    });
    roomtraceServer.listen(0, "127.0.0.1");
    await once(roomtraceServer, "listening");
    const config = {
      path: join(directory, "chat.sqlite"),
      token,
      capabilityUrl,
      roomtraceUrl: `http://127.0.0.1:${roomtraceServer.address().port}`,
      mcpUrl: `${capabilityUrl}/mcp`,
      hosts: ["localhost"],
      mcpTimeout: 900000,
      maxRounds: 12,
    };
    host = createHost(config);
    hostServer = host.app.listen(0, "127.0.0.1");
    await once(hostServer, "listening");
    const hostUrl = `http://127.0.0.1:${hostServer.address().port}`;
    assert.equal(
      (await fetch(`${hostUrl}/api/home`)).status,
      403,
      "Unexpected Host denied",
    );
    config.hosts.push(`127.0.0.1:${hostServer.address().port}`);
    const headers = { Host: "localhost" };
    assert.equal((await fetch(`${hostUrl}/api/home`, { headers })).status, 200);
    const uiLink = await fetch(
      `${hostUrl}/api/ui-actions/link_space_object`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          space_id: spaceId,
          element_id: "cabinet_2",
          asset_id: storageItem.id,
          space_name: "TEST room",
          element_label: "TEST second cabinet",
          revision: 1,
          request_id: randomUUID(),
        }),
      },
    );
    assert.equal(uiLink.status, 200);
    assert.equal((await uiLink.json()).element_label, "TEST second cabinet");
    const storageInput = {
      title: "TEST keys in unlinked container",
      content: "Second shelf, left side",
      kind: "location",
      source: "TEST human-selected item and container",
      asset_id: asset.id,
      space_id: spaceId,
      element_id: "unlinked_shelf",
      space_revision: 1,
      space_name: "TEST source model",
      element_label: "TEST unlinked shelf",
      request_id: randomUUID(),
    };
    const saveLocation = () => fetch(`${hostUrl}/api/ui-actions/save_spatial_location`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(storageInput),
    });
    const savedLocation = await saveLocation();
    assert.equal(savedLocation.status, 200);
    const savedLocationRecord = await savedLocation.json();
    assert.equal((await (await saveLocation()).json()).id, savedLocationRecord.id);
    const persistedLocation = capability.store.passport(asset.id).locations.find(
      (location) => location.id === savedLocationRecord.id,
    );
    assert.equal(persistedLocation.content, "Second shelf, left side");
    assert.equal(persistedLocation.element_label, "TEST unlinked shelf");
    assert.equal(persistedLocation.linked_revision, 1);
    const postSpatial = (name, input) => fetch(`${hostUrl}/api/ui-actions/${name}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, request_id: randomUUID() }),
    });
    const livePins = [
      ["link_space_object", { ...linkInput, element_id: "cabinet_2" }],
      ["save_spatial_task", { ...spatialTaskInput, element_id: "cabinet_2" }],
      ["schedule_spatial_maintenance", { ...spatialPlanInput, element_id: "cabinet_2" }],
      ["save_spatial_location", storageInput],
    ];
    for (const [name, input] of livePins)
      assert.equal((await postSpatial(name, input)).status, 200, name);
    const beforeStalePins = JSON.stringify(capability.store.home());
    roomtraceRevision = 2;
    for (const [name, input] of livePins) {
      assert.equal((await postSpatial(name, input)).status, 409, `Stale ${name}`);
      assert.equal(JSON.stringify(capability.store.home()), beforeStalePins);
    }
    roomtraceRevision = 1;
    for (const status of [404, 503]) {
      roomtraceStatus = status;
      for (const [name, input] of livePins) {
        assert.equal((await postSpatial(name, input)).status, 409, `Unavailable ${name}`);
        assert.equal(JSON.stringify(capability.store.home()), beforeStalePins);
      }
    }
    roomtraceStatus = 200;
    roomtraceRevision = null;
    assert.equal((await postSpatial("save_spatial_task", livePins[1][1])).status, 409);
    assert.equal(JSON.stringify(capability.store.home()), beforeStalePins);
    const beforeInvalidId = roomtraceRequests;
    assert.equal((await postSpatial("link_space_object", {
      ...linkInput, space_id: "../unexpected",
    })).status, 400);
    assert.equal(roomtraceRequests, beforeInvalidId, "Validate map IDs before requesting RoomTrace");
    assert.equal(JSON.stringify(capability.store.home()), beforeStalePins);
    await new Promise((resolve) => roomtraceServer.close(resolve));
    roomtraceServer = null;
    for (const [name, input] of livePins) {
      assert.equal((await postSpatial(name, input)).status, 409, `Offline ${name}`);
      assert.equal(JSON.stringify(capability.store.home()), beforeStalePins);
    }
    const forbiddenAnchor = await fetch(`${hostUrl}/api/actions/save_memory`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(storageInput),
    });
    assert.equal(forbiddenAnchor.status, 400);
    const hiddenLocationTool = await fetch(`${hostUrl}/api/actions/save_spatial_location`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(storageInput),
    });
    assert.equal(hiddenLocationTool.status, 404);
    const hiddenLinkTool = await fetch(
      `${hostUrl}/api/actions/link_space_object`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(linkInput),
      },
    );
    assert.equal(hiddenLinkTool.status, 404);
    const reportPath = `/api/assets/${asset.id}/report`;
    assert.equal((await fetch(`${capabilityUrl}${reportPath}`)).status, 401);
    assert.equal(
      (await fetch(`${hostUrl}/api/assets/${randomUUID()}/report`, { headers }))
        .status,
      404,
    );
    const report = await fetch(`${hostUrl}${reportPath}`, { headers });
    assert.equal(report.status, 200);
    assert.match(report.headers.get("content-disposition"), /attachment/);
    assert.match(report.headers.get("content-type"), /text\/plain/);
    const reportText = await report.text();
    assert.match(reportText, /HomeKeeper: TEST appliance/);
    assert.match(reportText, /TEST ONLY hose replaced/);
    assert.match(reportText, /provider: Test fixture/);
    assert.match(reportText, /USD.*82\.50/);
    assert.match(reportText, /IDR/);
    assert.match(reportText, /Test document/);
    assert.equal(
      (
        await fetch(`${hostUrl}/api/home`, {
          headers: { ...headers, Origin: "http://attacker.invalid" },
        })
      ).status,
      403,
    );
    const session = await (
      await fetch(`${hostUrl}/api/conversations`, { method: "POST", headers })
    ).json();
    const missing = await fetch(
      `${hostUrl}/api/conversations/${session.id}/turn`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Read my home" }),
      },
    );
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /NEBIUS/);
    assert.equal(
      host.agent.get(session.id).messages.length,
      0,
      "No canned model answer",
    );
    const status = await (
      await fetch(`${hostUrl}/api/status`, { headers })
    ).json();
    const streamed = await fetch(
      `${hostUrl}/api/conversations/${session.id}/turn`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({ message: "Read my home" }),
      },
    );
    assert.match(await streamed.text(), /"type":"error"/);
    assert.equal(status.model_configured, false);
    assert.equal(status.amazon_connected, false);
  } finally {
    if (client) await client.close();
    if (hostServer) await new Promise((resolve) => hostServer.close(resolve));
    if (capabilityServer)
      await new Promise((resolve) => capabilityServer.close(resolve));
    if (roomtraceServer)
      await new Promise((resolve) => roomtraceServer.close(resolve));
    host?.agent.close();
    capability?.store.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spatial ownership, revisions, anchor editing and invalid inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "homekeeper-spatial-"));
  const path = join(directory, "home.sqlite");
  let store = openStore(path);
  try {
    const container = execute(store, "save_home_item", { name: "Cabinet", category: "Furniture" });
    const stored = execute(store, "save_home_item", { name: "Keys", category: "Item" });
    const link = {
      space_id: "b".repeat(32), element_id: "cabinet_1",
      space_name: "Capture", element_label: "Cabinet", revision: 2,
      asset_id: container.id,
    };
    executeUiAction(store, "link_space_object", link);
    for (const invalid of [
      { space_id: "not-a-map" }, { element_id: "1bad" },
      { element_id: "a".repeat(65) }, { revision: 0 },
      { revision: 1.5 }, { asset_id: randomUUID() },
    ]) {
      assert.throws(() => executeUiAction(store, "link_space_object", { ...link, ...invalid }));
    }
    assert.throws(
      () => executeUiAction(store, "link_space_object", { ...link, revision: 1 }),
      /changed/,
    );
    const pin = { space_id: link.space_id, element_id: link.element_id, space_revision: 2 };
    const taskInput = { title: "Clean cabinet", kind: "task", asset_id: container.id, ...pin };
    const careInput = {
      title: "Care", due_on: "2030-01-01", source: "User date",
      asset_id: container.id, ...pin,
    };
    for (const [name, input] of [["save_spatial_task", taskInput], ["schedule_spatial_maintenance", careInput]]) {
      for (const invalid of [
        { asset_id: stored.id }, { asset_id: randomUUID() },
        { space_revision: 1 }, { space_revision: 3 },
        { element_id: "missing" }, { element_id: null },
        { space_id: null }, { space_revision: undefined },
      ]) assert.throws(() => executeUiAction(store, name, { ...input, ...invalid }));
    }
    const task = executeUiAction(store, "save_spatial_task", taskInput);
    const editedTask = execute(store, "save_task", {
      task_id: task.id, expected_revision: task.revision, title: "Wipe cabinet", kind: "task",
    });
    assert.equal(editedTask.asset_id, container.id);
    assert.equal(editedTask.space_revision, 2);
    const memoryInput = {
      title: "Keys location", content: "Top drawer, behind tray", kind: "location",
      source: "User selection", asset_id: stored.id, ...pin,
      space_name: link.space_name, element_label: link.element_label,
    };
    for (const invalid of [
      { asset_id: randomUUID() }, { asset_id: null }, { kind: "fact" },
      { space_id: null }, { element_id: null }, { space_revision: null },
      { space_name: undefined }, { element_label: undefined },
    ]) assert.throws(() => executeUiAction(store, "save_spatial_location", { ...memoryInput, ...invalid }));
    const memory = executeUiAction(store, "save_spatial_location", memoryInput);
    assert.equal(store.passport(stored.id).locations[0].asset_id, stored.id);
    executeUiAction(store, "link_space_object", { ...link, revision: 3, element_label: "Renamed cabinet" });
    assert.equal(store.passport(stored.id).locations[0].element_label, "Cabinet");
    assert.equal(store.passport(stored.id).locations[0].linked_revision, 2);
    assert.equal(store.home().tasks.find((row) => row.id === task.id).linked_revision, 2);
    const edit = {
      memory_id: memory.id, expected_revision: memory.revision,
      title: memory.title, content: "Bottom drawer", kind: "location", source: "User correction",
    };
    for (const invalid of [
      { asset_id: container.id }, { asset_id: null }, { kind: "fact" },
      { space_id: link.space_id }, { space_id: null, element_id: null },
    ]) assert.throws(() => execute(store, "save_memory", { ...edit, ...invalid }));
    const corrected = execute(store, "save_memory", edit);
    assert.equal(corrected.asset_id, stored.id);
    assert.equal(corrected.element_id, link.element_id);
    assert.equal(corrected.space_revision, 2);
    store.close();
    store = openStore(path);
    assert.equal(store.passport(stored.id).locations[0].content, "Bottom drawer");
    assert.equal(store.passport(stored.id).locations[0].element_label, "Cabinet");
    const cleared = executeUiAction(store, "save_spatial_location", {
      ...edit, expected_revision: corrected.revision, space_id: null, element_id: null,
    });
    assert.equal(cleared.asset_id, stored.id);
    for (const field of ["space_id", "element_id", "space_name", "element_label", "space_revision"])
      assert.equal(cleared[field], null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("confirmed text-location resolution and stale-anchor reconfirmation preserve reported memory", () => {
  const directory = mkdtempSync(join(tmpdir(), "homekeeper-location-resolution-"));
  const store = openStore(join(directory, "home.sqlite"));
  try {
    const item = execute(store, "save_home_item", { name: "Keys", category: "Belonging" });
    const memory = execute(store, "save_memory", {
      title: "Keys location", content: "Kitchen cabinet, top drawer", kind: "location",
      asset_id: item.id, source: "User report",
    });
    const confirmation = {
      memory_id: memory.id, expected_revision: memory.revision, space_id: "c".repeat(32),
      element_id: "cabinet", space_revision: 2, space_name: "Kitchen", element_label: "Cabinet",
    };
    assert.equal(tools.resolve_spatial_location, undefined, "AI cannot resolve or reconfirm a model pin");
    assert.throws(() => execute(store, "resolve_spatial_location", confirmation), /Unknown tool/);
    for (const invalid of [
      { asset_id: item.id }, { content: "A guess" }, { expected_revision: undefined },
      { space_revision: null }, { element_id: null }, { space_name: "" },
    ]) assert.throws(() => executeUiAction(store, "resolve_spatial_location", { ...confirmation, ...invalid }));
    const linked = executeUiAction(store, "resolve_spatial_location", confirmation);
    assert.equal(linked.revision, memory.revision + 1);
    for (const field of ["asset_id", "title", "content", "kind", "source"])
      assert.equal(linked[field], memory[field], `Confirmation preserves ${field}`);
    assert.equal(linked.space_revision, 2);
    assert.throws(() => executeUiAction(store, "resolve_spatial_location", confirmation), /record changed/);
    const reconfirmed = executeUiAction(store, "resolve_spatial_location", {
      ...confirmation, expected_revision: linked.revision, space_revision: 3, element_label: "Renamed cabinet",
    });
    assert.equal(reconfirmed.space_revision, 3);
    assert.equal(reconfirmed.content, memory.content);
    assert.equal(reconfirmed.source, memory.source);
    const fact = execute(store, "save_memory", { title: "Preference", content: "Quiet", kind: "preference", source: "User" });
    assert.throws(() => executeUiAction(store, "resolve_spatial_location", {
      ...confirmation, memory_id: fact.id, expected_revision: fact.revision,
    }), /saved location attached/);
    const unattached = execute(store, "save_memory", { title: "Drawer location", content: "Kitchen", kind: "location", source: "User" });
    assert.throws(() => executeUiAction(store, "resolve_spatial_location", {
      ...confirmation, memory_id: unattached.id, expected_revision: unattached.revision,
    }), /saved location attached/);
    assert.equal(store.passport(item.id).locations[0].element_label, "Renamed cabinet");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const hasAnchors of [false, true]) {
test(`existing SQLite schema (${hasAnchors ? "legacy anchors" : "pre-spatial"}) migrates without data loss`, () => {
  const directory = mkdtempSync(join(tmpdir(), "homekeeper-migration-"));
  const path = join(directory, "home.sqlite");
  const assetId = randomUUID(), memoryId = randomUUID(), planId = randomUUID(), taskId = randomUUID();
  const spaceId = "c".repeat(32);
  let legacy = new DatabaseSync(path), store;
  try {
    legacy.exec(`
      CREATE TABLE assets (id TEXT PRIMARY KEY,name TEXT NOT NULL,room TEXT NOT NULL,category TEXT NOT NULL,
        brand TEXT NOT NULL,model TEXT NOT NULL,serial TEXT NOT NULL,purchased_on TEXT,warranty_until TEXT,
        notes TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE maintenance (id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id),
        title TEXT NOT NULL,due_on TEXT,interval_days INTEGER,source TEXT NOT NULL,last_completed_on TEXT);
      CREATE TABLE memories (id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,
        asset_id TEXT REFERENCES assets(id),source TEXT NOT NULL,revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL${hasAnchors ? ",space_id TEXT,element_id TEXT" : ""});
      CREATE TABLE space_objects (space_id TEXT NOT NULL,element_id TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id),space_name TEXT NOT NULL,element_label TEXT NOT NULL,
        PRIMARY KEY(space_id,element_id));
      CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,notes TEXT NOT NULL,
        asset_id TEXT REFERENCES assets(id),due_on TEXT,interval_days INTEGER,status TEXT NOT NULL,
        last_completed_on TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL);
    `);
    legacy.prepare("INSERT INTO assets VALUES (?,?,?,'Item','','','',NULL,NULL,'','2025-01-01')").run(assetId, "Legacy keys", "Room");
    legacy.prepare("INSERT INTO maintenance VALUES (?,?,?,'2030-01-01',30,'User schedule',NULL)").run(planId, assetId, "Legacy care");
    legacy.prepare("INSERT INTO tasks VALUES (?,?,?,'',?,'2030-01-01',NULL,'open',NULL,2,'2025-01-01')").run(taskId, "Legacy task", "task", assetId);
    legacy.prepare("INSERT INTO space_objects VALUES (?,'cabinet',?,'Legacy capture','Legacy cabinet')").run(spaceId, assetId);
    if (hasAnchors)
      legacy.prepare("INSERT INTO memories VALUES (?,?,'Shelf 2','location',?,'User',4,'2025-01-01',?,'cabinet')").run(memoryId, "Legacy location", assetId, spaceId);
    else
      legacy.prepare("INSERT INTO memories VALUES (?,?,'Shelf 2','location',?,'User',4,'2025-01-01')").run(memoryId, "Legacy location", assetId);
    legacy.close();
    legacy = null;
    store = openStore(path);
    assert.equal(store.passport(assetId).name, "Legacy keys");
    const memory = store.passport(assetId).locations[0];
    assert.equal(memory.id, memoryId);
    assert.equal(memory.content, "Shelf 2");
    assert.equal(memory.revision, 4);
    assert.equal(memory.space_name, hasAnchors ? "Legacy capture" : null);
    assert.equal(memory.element_label, hasAnchors ? "Legacy cabinet" : null);
    assert.equal(memory.linked_revision, hasAnchors ? 1 : null);
    assert.equal(store.passport(assetId).maintenance[0].id, planId);
    assert.equal(store.passport(assetId).maintenance[0].revision, 1);
    assert.equal(store.home().tasks[0].id, taskId);
    assert.equal(store.home().tasks[0].revision, 2);
    assert.equal(store.home().tasks[0].space_id, null);
    const corrected = execute(store, "save_memory", {
      memory_id: memoryId, expected_revision: 4, title: memory.title,
      kind: "location", content: "Shelf 3", source: "User correction",
    });
    assert.equal(corrected.asset_id, assetId);
    assert.equal(corrected.space_id, hasAnchors ? spaceId : null);
    store.close();
    store = openStore(path);
    assert.equal(store.passport(assetId).locations[0].content, "Shelf 3");
    assert.equal(store.passport(assetId).locations[0].linked_revision, hasAnchors ? 1 : null);
  } finally {
    legacy?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { openStore } from "../capability/store.js";
import { execute } from "../capability/tools.js";
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
  let capabilityServer, hostServer, capability, host, client;
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
    const config = {
      path: join(directory, "chat.sqlite"),
      token,
      capabilityUrl,
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
    host?.agent.close();
    capability?.store.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

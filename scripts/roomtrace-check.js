import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { createCapability } from "../capability/server.js";
import { createHost } from "../alexa_host/server.js";
import { targetFloor } from "../web/spaces/architecture/target-floor.js";

const twoFloorDocument = {
  levels: [{ id: "ground" }, { id: "upper" }],
  elements: [{ id: "upper-cabinet", level: "upper" }],
};
assert.deepEqual(targetFloor(twoFloorDocument, "upper-cabinet"),
  { level: "upper", allFloors: false },
  "Saved targets on the second floor initialize that floor, not the first or all floors");
assert.deepEqual(targetFloor(twoFloorDocument, "missing-element"),
  { level: "ground", allFloors: true },
  "Missing saved elements retain the default floor fallback");

const temporary = mkdtempSync(join(tmpdir(), "homekeeper-roomtrace-"));
const data = join(temporary, "geometry");
mkdirSync(data);
const source = "features/roomtrace/data";
let capture, createdCapture;
if (existsSync(`${source}/jobs.sqlite3`)) {
  const db = new DatabaseSync(`${source}/jobs.sqlite3`, { readOnly: true });
  capture = db
    .prepare("SELECT payload FROM jobs ORDER BY rowid DESC")
    .all()
    .map((row) => JSON.parse(row.payload))
    .find(
      (job) => job.status === "ready" && job.options.engine === "architecture",
    );
  db.close();
  if (capture) {
    cpSync(`${source}/${capture.id}`, `${data}/${capture.id}`, {
      recursive: true,
    });
    if (existsSync(`${source}/assets`))
      cpSync(`${source}/assets`, `${data}/assets`, { recursive: true });
    const copy = new DatabaseSync(`${data}/jobs.sqlite3`);
    copy.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    copy
      .prepare("INSERT INTO jobs VALUES (?, ?)")
      .run(capture.id, JSON.stringify(capture));
    copy.close();
  }
}
const token = randomUUID() + randomUUID();
const socket = createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const engine = spawn(process.env.ROOMTRACE_PYTHON || "python3", ["run.py"], {
  cwd: "features/roomtrace",
  env: {
    ...process.env,
    HOMEKEEPER_TOKEN: token,
    ROOMTRACE_PORT: String(port),
    ROOMTRACE_HOST: "127.0.0.1",
    ROOMTRACE_DATA: data,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let capability, host, capabilityServer, hostServer, browser;
try {
  await new Promise((resolve, reject) => {
    let log = "";
    engine.stderr.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("Uvicorn running on")) resolve();
    });
    engine.once("error", reject);
    engine.once("exit", (code) =>
      reject(new Error(`RoomTrace exited with ${code} before startup. ${log}`)),
    );
  });
  const upstream = `http://127.0.0.1:${port}`;
  assert.equal(
    (await fetch(`${upstream}/api/maps`)).status,
    401,
    "The geometry service requires server authentication",
  );
  capability = createCapability({
    path: join(temporary, "home.sqlite"),
    token,
  });
  capabilityServer = capability.app.listen(0, "127.0.0.1");
  await once(capabilityServer, "listening");
  const capabilityUrl = `http://127.0.0.1:${capabilityServer.address().port}`;
  const config = {
    path: join(temporary, "chat.sqlite"),
    token,
    capabilityUrl,
    mcpUrl: `${capabilityUrl}/mcp`,
    roomtraceUrl: upstream,
    hosts: [],
    mcpTimeout: 900000,
    maxRounds: 12,
    model: process.env.NEBIUS_MODEL,
    apiKey: process.env.NEBIUS_API_KEY,
    baseUrl: process.env.NEBIUS_BASE_URL,
  };
  host = createHost(config);
  hostServer = host.app.listen(0, "127.0.0.1");
  await once(hostServer, "listening");
  const url = `http://127.0.0.1:${hostServer.address().port}`;
  config.hosts.push(new URL(url).host);
  const api = `${url}/roomtrace/api`;
  const document = await fetch(`${url}/`);
  assert.equal(document.status, 200);
  assert.equal(document.headers.get("x-frame-options"), "DENY");
  assert.match(
    document.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(`${api}/health`)).status, 200);
  assert.equal((await fetch(`${api}/maps`)).status, 200);
  assert.equal(
    (
      await fetch(`${api}/maps`, {
        headers: { Origin: "https://other.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${api}/maps/invalid/scene`)).status, 404);
  assert.equal(
    (await fetch(`${api}/maps`, { method: "POST", body: new FormData() }))
      .status,
    422,
  );
  assert.equal(
    (await fetch(`${url}/api/home`)).status,
    200,
    "Home record routes still work",
  );
  if (capture) {
    const frames = JSON.parse(
      readFileSync(`${data}/${capture.id}/frames.json`),
    );
    const upload = new FormData();
    upload.set("name", "TEST gateway capture");
    upload.set("engine", "architecture");
    for (const frame of frames) {
      const bytes = readFileSync(`${data}/${capture.id}/images/${frame.name}`);
      upload.append(
        "files",
        new Blob([bytes], { type: "image/jpeg" }),
        frame.name,
      );
    }
    const response = await fetch(`${api}/maps`, {
      method: "POST",
      body: upload,
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    let state;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await (await fetch(`${api}/maps/${created.id}`)).json();
    } while (["queued", "running"].includes(state.status));
    assert.equal(
      state.status,
      "awaiting_agent",
      "Real frame preprocessing completes; no fabricated model is generated",
    );
    createdCapture = created;
    const picture = await fetch(
      `${api}/maps/${capture.id}/images/${frames[0].name}`,
    );
    assert.equal(picture.status, 200);
    assert.match(picture.headers.get("content-type"), /^image\//);
    const model = await fetch(
      `${api}/maps/${capture.id}/artifacts/surface.glb`,
    );
    assert.equal(model.status, 200);
    assert.equal(
      Buffer.from(await model.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
    const structure = await fetch(
      `${api}/maps/${capture.id}/architecture/structure`,
    );
    assert.equal(structure.status, 200);
  }
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  page.on("requestfailed", (request) =>
    console.error(
      "Failed browser request:",
      request.url(),
      request.failure()?.errorText,
    ),
  );
  await page.goto(url);
  await page
    .getByRole("heading", { name: "What can I take care of?" })
    .waitFor();
  const conversationStyle = await page
    .locator(".conversation-intro h1")
    .evaluate((node) => ({
      font: getComputedStyle(node).font,
      margin: getComputedStyle(node).margin,
    }));
  const draft = "Draft preserved across Spaces navigation";
  const canType = await page.locator("#message").isEnabled();
  if (canType) await page.locator("#message").fill(draft);
  await page.getByRole("button", { name: "Your home", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item name", { exact: true }).fill("TEST spatial item");
  await page.getByLabel("Room", { exact: true }).fill("TEST spatial room");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".item-row").getByText("TEST spatial item", { exact: true }).waitFor();
  const spatialItem = capability.store
    .home()
    .assets.find((item) => item.name === "TEST spatial item");
  assert.ok(spatialItem, "Create an actual HomeKeeper item in the UI");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item name", { exact: true }).fill("TEST stored flashlight");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".item-row").getByText("TEST stored flashlight", { exact: true }).waitFor();
  const storedItem = capability.store
    .home()
    .assets.find((item) => item.name === "TEST stored flashlight");
  assert.ok(storedItem, "Storage uses a distinct explicitly selected household item");
  await page.getByRole("button", { name: "Spaces", exact: true }).click();
  const spaces = page.locator(".spaces-workspace");
  assert.equal(
    await page.locator("iframe").count(),
    0,
    "Spaces renders in the native React tree",
  );
  await spaces
    .getByRole("button", { name: "New space", exact: true })
    .waitFor()
    .catch(async (error) => {
      mkdirSync(".impeccable/review", { recursive: true });
      await page.screenshot({
        path: ".impeccable/review/spaces-failure.png",
        fullPage: true,
      });
      console.error("Workspace errors:", errors);
      throw error;
    });
  assert.equal(
    await page.getByRole("main", { name: "Conversation" }).isVisible(),
    false,
  );
  assert.equal(
    await spaces.getByRole("navigation", { name: "Spaces navigation" }).count(),
    1,
  );
  assert.equal(
    await spaces.locator(".rail, .brand, .sign-in").count(),
    0,
    "No duplicate app navigation or sign-in",
  );
  mkdirSync(".impeccable/review", { recursive: true });
  await page.screenshot({
    path: ".impeccable/review/spaces-capture.png",
    fullPage: true,
  });
  if (capture) {
    await spaces
      .getByRole("button", { name: "Your spaces", exact: true })
      .click();
    await spaces
      .getByRole("button", {
        name: new RegExp(capture.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      })
      .click();
    await spaces.locator("canvas").first().waitFor();
    const modelBounds = await spaces.locator(".model-layout").boundingBox();
    assert.ok(
      modelBounds.width > 1280,
      "The model uses the available desktop page width",
    );
    await spaces.getByRole("button", { name: "Photos", exact: true }).click();
    await spaces.locator(".architecture-source img").first().waitFor();
    await spaces.getByRole("button", { name: "Objects", exact: true }).click();
    const architecture = await (
      await fetch(`${api}/maps/${capture.id}/architecture`)
    ).json();
    const photoBackedPart = architecture.document.elements.find((item) => item.sources?.length);
    assert.ok(photoBackedPart, "The saved model includes photo-backed objects");
    const evidenceElement = architecture.document.elements.find((item) =>
      photoBackedPart.assembly ? item.assembly === photoBackedPart.assembly : item.id === photoBackedPart.id,
    );
    const objectName = evidenceElement.assembly || evidenceElement.label;
    const objectButton = spaces
      .locator(`.object-list button[data-element-id="${evidenceElement.id}"]`);
    await objectButton.click();
    await spaces.locator(".object-inspector").waitFor();
    assert.equal(
      await spaces.locator(".object-inspector").getAttribute("data-element-id"),
      evidenceElement.id,
      "Object selection uses the exact saved element ID",
    );
    await spaces.getByText("Photo evidence", { exact: true }).click();
    const sourcePhoto = spaces.locator(".source-links button").first();
    assert.ok((await sourcePhoto.count()) > 0);
    await sourcePhoto.click();
    const evidenceImage = spaces.locator(".architecture-source img");
    await evidenceImage.waitFor();
    const displayedPhoto = await spaces.getByLabel("Source photo", { exact: true }).inputValue();
    const objectSources = architecture.document.elements
      .filter((part) => part.id === evidenceElement.id || (evidenceElement.assembly && part.assembly === evidenceElement.assembly))
      .flatMap((part) => part.sources || []);
    assert.ok(objectSources.includes(displayedPhoto), "Evidence opens a source belonging to the selected object");
    assert.equal(
      new URL(await evidenceImage.getAttribute("src"), url).pathname,
      `/roomtrace/api/maps/${capture.id}/images/${displayedPhoto}`,
    );
    await evidenceImage.evaluate((image) => {
      if (image.complete && image.naturalWidth > 0) return;
      return new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new Error("The actual source photo failed to load")), { once: true });
      });
    });
    await page.screenshot({
      path: ".impeccable/review/spaces-feature-source-photo.png",
      fullPage: true,
    });
    await spaces.getByRole("button", { name: "Objects", exact: true }).click();
    async function saveSpatialAction(action, buttonName) {
      const actionPath = "ui-actions";
      const [response] = await Promise.all([
        page.waitForResponse((response) =>
          response.url() === `${url}/api/${actionPath}/${action}` &&
          response.request().method() === "POST",
        ),
        spaces.getByRole("button", { name: buttonName, exact: true }).click(),
      ]);
      const submitted = response.request().postDataJSON();
      if (["save_spatial_task", "schedule_spatial_maintenance"].includes(action)) {
        const liveScene = await (await fetch(`${api}/maps/${capture.id}/scene`)).json();
        assert.equal(submitted.space_revision, liveScene.revision,
          "Care pins use the current loaded RoomTrace revision");
      }
      assert.equal(response.status(), 200, await response.text());
      await spaces.getByText("Saved to HomeKeeper.", { exact: true }).waitFor();
    }
    await spaces.getByLabel("Home item stored here").selectOption(storedItem.id);
    await spaces.getByLabel("Storage location detail").fill("Inside the lower drawer");
    await saveSpatialAction("save_spatial_location", "Remember this location");
    assert.equal(capability.store.home().space_objects.length, 0,
      "Storage is confirmed on an unlinked container; no identity link is required");
    await spaces.getByLabel("Home item to link").selectOption(spatialItem.id);
    await saveSpatialAction("link_space_object", "Link to home item");
    const createdLink = capability.store
      .home()
      .space_objects.find(
        (item) =>
          item.space_id === capture.id &&
          item.element_id === evidenceElement.id,
      );
    assert.equal(
      createdLink?.asset_id,
      spatialItem.id,
      await spaces.locator(".object-inspector").innerText(),
    );
    assert.equal(createdLink.space_name, capture.name);
    assert.equal(createdLink.element_label, objectName);
    const selectedScene = await (await fetch(`${api}/maps/${capture.id}/scene`)).json();
    assert.equal(createdLink.revision, selectedScene.revision);
    await spaces
      .getByLabel("Task for linked home item")
      .fill("TEST spatial task");
    await saveSpatialAction("save_spatial_task", "Create pinned task");
    await spaces
      .getByLabel("Maintenance plan title")
      .fill("TEST spatial maintenance");
    await spaces.getByLabel("Maintenance due date").fill("2030-02-03");
    await spaces
      .getByLabel("Maintenance repeat interval in days")
      .fill("30");
    await spaces
      .getByLabel("Maintenance schedule source")
      .fill("TEST household-provided schedule");
    await saveSpatialAction("schedule_spatial_maintenance", "Pin maintenance to object");
    const linkedTask = capability.store
      .home()
      .tasks.find((task) => task.title === "TEST spatial task");
    const linkedMaintenance = capability.store
      .home()
      .maintenance.find((plan) => plan.title === "TEST spatial maintenance");
    const savedLocation = capability.store
      .home()
      .memories.find((memory) => memory.content === "Inside the lower drawer");
    for (const record of [linkedTask, linkedMaintenance, savedLocation]) {
      assert.ok(record, "A confirmed UI action creates a real HomeKeeper record");
      assert.equal(record.asset_id, record === savedLocation ? storedItem.id : spatialItem.id);
      assert.equal(record.space_id, capture.id);
      assert.equal(record.element_id, evidenceElement.id);
      assert.equal(record.space_name, capture.name);
      assert.equal(record.element_label, objectName);
    }
    assert.equal(linkedTask.space_revision, selectedScene.revision);
    assert.equal(linkedMaintenance.space_revision, selectedScene.revision);
    assert.equal(linkedTask.due_on, null, "No task date is fabricated");
    assert.equal(linkedMaintenance.due_on, "2030-02-03");
    assert.equal(linkedMaintenance.interval_days, 30);
    assert.equal(linkedMaintenance.source, "TEST household-provided schedule");
    assert.equal(savedLocation.kind, "location");
    assert.equal(capability.store.home().space_objects.some((link) => link.asset_id === storedItem.id), false,
      "Remembering a stored item does not identify the container as that item");
    await spaces.getByRole("button", { name: spatialItem.name, exact: true }).click();
    const passport = page.locator(".passport");
    await passport.waitFor();
    await passport.getByRole("heading", { name: spatialItem.name, exact: true }).waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector(
        ".passport .home-spatial-card .home-spatial-preview img",
      );
      return image?.complete && image.naturalWidth > 0;
    });
    await page.screenshot({
      path: ".impeccable/review/spaces-feature-item-record.png",
      fullPage: true,
    });
    await passport.getByText("Care & tasks", { exact: true }).click();
    const careSection = passport
      .locator("details.record-section")
      .filter({ hasText: "Care & tasks" });
    await careSection
      .locator(".task-row")
      .filter({ hasText: linkedTask.title })
      .waitFor({ timeout: 5000 });
    await careSection
      .locator(".task-row")
      .filter({ hasText: linkedMaintenance.title })
      .waitFor({ timeout: 5000 });
    await page.waitForFunction(() => {
      const images = [
        ...document.querySelectorAll(
          ".passport .home-spatial-card--compact .home-spatial-preview img",
        ),
      ];
      return images.length >= 2 && images.every(
        (image) => image.complete && image.naturalWidth > 0,
      );
    });
    await page.screenshot({
      path: ".impeccable/review/spaces-feature-care-records.png",
      fullPage: true,
    });
    async function assertSelectedModelTarget(context, target = evidenceElement) {
      await spaces.locator(`.object-inspector[data-element-id="${target.id}"]`).waitFor();
      const route = new URLSearchParams(new URL(page.url()).hash.slice(1));
      assert.equal(route.get("space"), capture.id, `${context}: the saved space is routed`);
      assert.equal(route.get("element"), target.id, `${context}: the exact saved object is routed`);
      const model = spaces.getByRole("region", { name: "Architectural model", exact: true });
      const canvas = model.locator("canvas");
      await canvas.waitFor({ state: "visible" });
      const bounds = await canvas.boundingBox();
      assert.ok(bounds?.width > 0 && bounds?.height > 0, `${context}: the 3D canvas is visible`);
      assert.equal(await model.getByLabel("Model viewpoint", { exact: true }).inputValue(), "entry",
        `${context}: the object opens in perspective 3D, not the top-down plan`);
      assert.equal(await model.getByRole("button", { name: "Focus", exact: true }).getAttribute("aria-pressed"), "true",
        `${context}: the selected object is focused in the canvas`);
      assert.equal(await model.getByLabel("Visible floors", { exact: true }).inputValue(), target.level,
        `${context}: the object's actual floor is visible`);
      assert.equal(await spaces.locator(".architecture-source img").isVisible(), false,
        `${context}: the source-photo panel is not the model destination`);
    }
    await passport.getByRole("button", {
      name: `${createdLink.space_name} · ${createdLink.element_label} — Open in Spaces`,
      exact: true,
    }).first().click();
    await assertSelectedModelTarget("Item passport");
    await page.screenshot({
      path: ".impeccable/review/spaces-feature-focused-model.png",
      fullPage: true,
    });
    await spaces.getByLabel("Home item stored here").selectOption(storedItem.id);
    assert.equal(await spaces.getByLabel("Storage location detail").inputValue(), savedLocation.content);
    for (const record of [linkedTask, linkedMaintenance]) {
      await spaces.getByRole("button", { name: spatialItem.name, exact: true }).click();
      await passport.getByRole("heading", { name: spatialItem.name, exact: true }).waitFor();
      if ((await careSection.getAttribute("open")) === null) {
        await passport.getByText("Care & tasks", { exact: true }).click();
      }
      const careCard = careSection.locator(".task-row").filter({ hasText: record.title });
      const modelAction = careCard.getByRole("button", {
        name: `${record.space_name} · ${record.element_label} — Open in Spaces`,
        exact: true,
      });
      await modelAction.waitFor({ state: "visible" });
      await modelAction.click();
      await assertSelectedModelTarget(record.title);
    }
    await page.getByRole("button", { name: "Your home", exact: true }).click();
    await page.locator(".item-row").filter({ hasText: storedItem.name }).click();
    await passport.getByRole("heading", { name: storedItem.name, exact: true }).waitFor();
    await passport.getByText(savedLocation.content, { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector(
        ".passport .home-spatial-card .home-spatial-preview img",
      );
      return image?.complete && image.naturalWidth > 0;
    });
    await page.screenshot({
      path: ".impeccable/review/spaces-feature-storage-location.png",
      fullPage: true,
    });
    await passport.getByRole("button", {
      name: `${savedLocation.space_name} · ${savedLocation.element_label} — Show in Spaces`,
      exact: true,
    }).click();
    await assertSelectedModelTarget("Stored-item location");
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    let memoryRow = page.locator(".memory-row").filter({ hasText: savedLocation.title });
    await memoryRow.getByText(savedLocation.content, { exact: true }).waitFor();
    await memoryRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("What to remember", { exact: true }).fill("Inside the lower drawer, left side");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const editedNote = page.locator(".memory-row").filter({ hasText: savedLocation.title })
      .locator(".home-spatial-note");
    if ((await editedNote.getAttribute("open")) === null) {
      await editedNote.locator("summary").click();
    }
    await page.getByText("Inside the lower drawer, left side", { exact: true }).waitFor();
    const editedLocation = capability.store.home().memories.find((memory) => memory.id === savedLocation.id);
    assert.equal(editedLocation.asset_id, storedItem.id);
    assert.equal(editedLocation.space_id, capture.id);
    assert.equal(editedLocation.element_id, evidenceElement.id);
    assert.equal(editedLocation.space_name, capture.name);
    assert.equal(editedLocation.element_label, objectName);
    memoryRow = page.locator(".memory-row").filter({ hasText: savedLocation.title });
    await memoryRow.getByRole("button", { name: "Show in Spaces", exact: true }).click();
    await assertSelectedModelTarget("Edited storage memory");
    await spaces.getByLabel("Home item stored here").selectOption(storedItem.id);
    assert.equal(await spaces.getByLabel("Storage location detail").inputValue(), editedLocation.content);
    console.log(
      "PASS: exact model object opens its linked item; task and maintenance stay pinned; a distinct stored item's location and text edits reopen the container; its actual source photo loads.",
    );
    const upperFloorElement = architecture.document.elements.find((item) =>
      item.level !== architecture.document.levels[0].id,
    );
    if (upperFloorElement) {
      await page.evaluate(({ space, element }) => {
        location.hash = new URLSearchParams({ space, element }).toString();
      }, { space: capture.id, element: upperFloorElement.id });
      await spaces.locator(`.object-inspector[data-element-id="${upperFloorElement.id}"]`).waitFor();
      assert.equal(await spaces.getByLabel("Visible floors", { exact: true }).inputValue(), upperFloorElement.level,
        "A saved target on another floor opens on that floor, not the first floor or all floors");
      await assertSelectedModelTarget("Upper-floor saved target", upperFloorElement);
      await page.evaluate(({ space, element }) => {
        location.hash = new URLSearchParams({ space, element }).toString();
      }, { space: capture.id, element: evidenceElement.id });
      await spaces.locator(`.object-inspector[data-element-id="${evidenceElement.id}"]`).waitFor();
    }
    await spaces.getByRole("button", { name: "Measure", exact: true }).click();
    await spaces
      .getByRole("button", { name: "Walkthrough", exact: true })
      .click();
    await spaces.getByRole("region", { name: "Guided walkthrough" }).waitFor();
    await spaces
      .getByText("Checking floor clearance…", { exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollHeight > innerHeight,
      ),
      false,
      "The desktop model fits the available viewport height",
    );
    await page.screenshot({
      path: ".impeccable/review/spaces-model.png",
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  assert.equal(
    await spaces.count(),
    0,
    "Leaving unmounts the modeling workspace and its camera",
  );
  assert.equal(
    await page.locator("#message").inputValue(),
    canType ? draft : "",
  );
  assert.deepEqual(
    await page.locator(".conversation-intro h1").evaluate((node) => ({
      font: getComputedStyle(node).font,
      margin: getComputedStyle(node).margin,
    })),
    conversationStyle,
    "Feature styles do not leak into Conversation",
  );
  await page.getByRole("button", { name: "Spaces", exact: true }).click();
  if (capture) await spaces.locator("canvas").first().waitFor();
  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: ".impeccable/review/spaces-model-narrow.png",
    fullPage: true,
  });
  await spaces.getByRole("button", { name: "New space", exact: true }).click();
  await spaces.getByRole("heading", { name: "Your space, in 3D." }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(errors, [], "No uncaught UI errors");
  const mcp = spawn(
    process.env.ROOMTRACE_PYTHON || "python3",
    ["tests/check_mcp.py", ...(createdCapture ? [createdCapture.id] : [])],
    {
      cwd: "features/roomtrace",
      env: {
        ...process.env,
        HOMEKEEPER_TOKEN: token,
        ROOMTRACE_DATA: data,
        ROOMTRACE_MCP_URL: `${api}/`,
      },
      stdio: "inherit",
    },
  );
  assert.equal(
    (await once(mcp, "exit"))[0],
    0,
    "Real MCP tools work through HomeKeeper",
  );
  if (createdCapture) {
    const published = await (
      await fetch(`${api}/maps/${createdCapture.id}/scene`)
    ).json();
    assert.equal(published.mode, "architecture");
    assert.equal(published.revision, 1);
    assert.ok(published.surface_triangles > 0);
    const downloaded = await fetch(
      `${api}/maps/${createdCapture.id}/artifacts/surface.glb`,
    );
    assert.equal(downloaded.status, 200);
    assert.equal(
      Buffer.from(await downloaded.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
    await spaces
      .getByRole("button", { name: "Your spaces", exact: true })
      .click();
    await spaces.getByRole("button", { name: /TEST gateway capture/ }).click();
    await spaces.locator("canvas").first().waitFor();
    await spaces.getByRole("button", { name: "Measure", exact: true }).click();
    await spaces
      .getByRole("button", { name: "Walkthrough", exact: true })
      .click();
    await spaces
      .getByText("Checking floor clearance…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({
      path: ".impeccable/review/spaces-published.png",
      fullPage: true,
    });
    assert.deepEqual(
      errors,
      [],
      "Published reconstruction has no uncaught UI errors",
    );
    console.log(
      "PASS: newly published four-photo capture renders through HomeKeeper, with measurement/walkthrough surfaces and an actual GLB download.",
    );
  }
  engine.kill("SIGTERM");
  await once(engine, "exit");
  await page.goto(`${url}/?view=spaces`);
  await spaces
    .getByRole("button", { name: "Try again", exact: true })
    .waitFor();
  await page.screenshot({
    path: ".impeccable/review/spaces-unavailable.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  assert.equal(
    await page.getByRole("main", { name: "Conversation" }).isVisible(),
    true,
  );
  assert.deepEqual(errors, [], "A geometry outage does not crash HomeKeeper");
  console.log(
    `PASS: native React workspace without iframes, full desktop width, isolated styles, geometry outage recovery, actual gateway, security, desktop menu, draft retention, workspace lifecycle and MCP.${capture ? " Saved model, source images, real upload and walkthrough UI checked." : " Saved-model/upload checks skipped: no local architecture capture."}`,
  );
} finally {
  if (browser) await browser.close();
  if (hostServer) await new Promise((resolve) => hostServer.close(resolve));
  if (capabilityServer)
    await new Promise((resolve) => capabilityServer.close(resolve));
  host?.agent.close();
  capability?.store.close();
  if (engine.kill("SIGTERM")) {
    await once(engine, "exit");
  }
  rmSync(temporary, { recursive: true, force: true });
}

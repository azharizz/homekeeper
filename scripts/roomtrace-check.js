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
  const document = await fetch(`${url}/roomtrace/`);
  assert.equal(document.status, 200);
  assert.equal(document.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(
    document.headers.get("content-security-policy"),
    /frame-ancestors 'self'/,
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
  const draft = "Draft preserved across RoomTrace navigation";
  const canType = await page.locator("#message").isEnabled();
  if (canType) await page.locator("#message").fill(draft);
  await page.getByRole("button", { name: "RoomTrace", exact: true }).click();
  const frame = page.frameLocator('iframe[title="RoomTrace 3D workspace"]');
  await frame
    .getByRole("button", { name: "New space", exact: true })
    .waitFor()
    .catch(async (error) => {
      mkdirSync(".impeccable/review", { recursive: true });
      await page.screenshot({
        path: ".impeccable/review/roomtrace-failure.png",
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
    await frame
      .getByRole("navigation", { name: "RoomTrace navigation" })
      .count(),
    1,
  );
  assert.equal(
    await frame.locator(".rail, .brand, .sign-in").count(),
    0,
    "No duplicate app navigation or sign-in",
  );
  mkdirSync(".impeccable/review", { recursive: true });
  await page.screenshot({
    path: ".impeccable/review/roomtrace-capture.png",
    fullPage: true,
  });
  if (capture) {
    await frame
      .getByRole("button", { name: "Your spaces", exact: true })
      .click();
    await frame
      .getByRole("button", {
        name: new RegExp(capture.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      })
      .click();
    await frame.locator("canvas").first().waitFor();
    await frame.getByRole("button", { name: "Photos", exact: true }).click();
    await frame.locator(".architecture-source img").first().waitFor();
    await frame.getByRole("button", { name: "Objects", exact: true }).click();
    await frame.getByRole("button", { name: "Measure", exact: true }).click();
    await frame
      .getByRole("button", { name: "Walkthrough", exact: true })
      .click();
    await frame.getByRole("region", { name: "Guided walkthrough" }).waitFor();
    await frame
      .getByText("Checking floor clearance…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({
      path: ".impeccable/review/roomtrace-model.png",
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  assert.equal(
    await page.locator("iframe").count(),
    0,
    "Leaving closes the camera workspace",
  );
  assert.equal(
    await page.locator("#message").inputValue(),
    canType ? draft : "",
  );
  await page.getByRole("button", { name: "RoomTrace", exact: true }).click();
  if (capture) await frame.locator("canvas").first().waitFor();
  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  const content = page
    .frames()
    .find((frame) => frame.url().startsWith(`${url}/roomtrace/`));
  assert.equal(
    await content.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await frame.getByRole("button", { name: "New space", exact: true }).click();
  await frame.getByRole("heading", { name: "Your space, in 3D." }).waitFor();
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
    await frame
      .getByRole("button", { name: "Your spaces", exact: true })
      .click();
    await frame.getByRole("button", { name: /TEST gateway capture/ }).click();
    await frame.locator("canvas").first().waitFor();
    await frame.getByRole("button", { name: "Measure", exact: true }).click();
    await frame
      .getByRole("button", { name: "Walkthrough", exact: true })
      .click();
    await frame
      .getByText("Checking floor clearance…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({
      path: ".impeccable/review/roomtrace-published.png",
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
  console.log(
    `PASS: actual gateway, security, desktop menu, draft retention, workspace lifecycle and MCP.${capture ? " Saved model, source images, real upload and walkthrough UI checked." : " Saved-model/upload checks skipped: no local architecture capture."}`,
  );
} finally {
  if (browser) await browser.close();
  if (hostServer) await new Promise((resolve) => hostServer.close(resolve));
  if (capabilityServer)
    await new Promise((resolve) => capabilityServer.close(resolve));
  host?.agent.close();
  capability?.store.close();
  if (engine.exitCode === null) {
    engine.kill("SIGTERM");
    await once(engine, "exit");
  }
  rmSync(temporary, { recursive: true, force: true });
}

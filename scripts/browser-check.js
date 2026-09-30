import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createCapability } from "../capability/server.js";
import { createHost } from "../alexa_host/server.js";

const directory = mkdtempSync(join(tmpdir(), "homekeeper-browser-"));
const token = randomUUID() + randomUUID();
const capability = createCapability({
  path: join(directory, "home.sqlite"),
  token,
});
const capabilityServer = capability.app.listen(0, "127.0.0.1");
await once(capabilityServer, "listening");
const capabilityUrl = `http://127.0.0.1:${capabilityServer.address().port}`;
const config = {
  path: join(directory, "chat.sqlite"),
  token,
  capabilityUrl,
  mcpUrl: `${capabilityUrl}/mcp`,
  hosts: [],
  mcpTimeout: 900000,
  maxRounds: 12,
  model: process.env.NEBIUS_MODEL,
  apiKey: process.env.NEBIUS_API_KEY,
  baseUrl: process.env.NEBIUS_BASE_URL,
};
const host = createHost(config);
const hostServer = host.app.listen(0, "127.0.0.1");
await once(hostServer, "listening");
const hostUrl = `http://127.0.0.1:${hostServer.address().port}`;
config.hosts.push(new URL(hostUrl).host);
let browser;
const screenshots = ".impeccable/review";
mkdirSync(screenshots, { recursive: true });
try {
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
  await page.goto(hostUrl);
  await page
    .getByRole("heading", { name: "What can I take care of?" })
    .waitFor();
  await page.screenshot({
    path: `${screenshots}/desktop-alexa-theme.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Your home", exact: true }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item name", { exact: true }).fill("TEST UI Plant");
  await page.getByLabel("Room", { exact: true }).fill("Test room");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: /TEST UI Plant/ }).click();
  await page
    .getByRole("heading", { name: "TEST UI Plant", exact: true })
    .waitFor();
  await page
    .locator(".record-section > summary")
    .filter({ hasText: "Files" })
    .click();
  await page
    .getByLabel("Upload PDF or text")
    .setInputFiles({
      name: "plant.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("TEST ONLY plant instructions"),
    });
  await page.getByRole("link", { name: "plant.txt", exact: true }).waitFor();
  await page.screenshot({
    path: `${screenshots}/passport-alexa-theme.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Care & tasks", exact: true }).click();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Task", { exact: true }).fill("TEST water plant");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "Complete TEST water plant", exact: true })
    .click();
  await page.getByText("No tasks here.", { exact: false }).waitFor();
  assert.equal(
    capability.store.home().tasks[0].status,
    "done",
    "Task completion takes one action",
  );
  await page.getByLabel("Care view").selectOption("done");
  await page
    .getByRole("heading", { name: "TEST water plant", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("TEST keys");
  await page
    .getByLabel("What to remember", { exact: true })
    .fill("Test red bowl");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("What to remember", { exact: true })
    .fill("Test blue bowl");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Test blue bowl", { exact: true }).waitFor();
  assert.equal(capability.store.home().memories.length, 1);
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove memory", exact: true })
    .click();
  await page.getByRole("button", { name: "Add memory", exact: true }).waitFor();
  assert.equal(capability.store.home().memories.length, 0);

  // Disposable fixtures check pagination without touching the real household.
  for (let n = 0; n < 9; n++) {
    const response = await fetch(`${hostUrl}/api/actions/save_home_item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `TEST extra ${n}`, category: "Test" }),
    });
    assert.equal(response.status, 200);
  }
  await page.reload();
  await page.getByRole("button", { name: "Your home", exact: true }).click();
  assert.equal(await page.locator(".item-row").count(), 8);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await page.locator(".item-row").count(), 2);
  await page.getByLabel("Find an item or room").fill("UI Plant");
  assert.equal(
    await page.locator(".item-row").count(),
    1,
    "Search resets pagination",
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByLabel("Upload PDF or text")
    .setInputFiles({
      name: "unfiled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("TEST ONLY unidentified receipt"),
    });
  await page.getByRole("link", { name: "unfiled.txt", exact: true }).waitFor();
  assert.equal(
    capability.store.home().documents.find((d) => d.title === "unfiled.txt")
      .asset_id,
    null,
  );
  await page.screenshot({
    path: `${screenshots}/files-alexa-theme.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message HomeKeeper" })
      .isDisabled(),
    !config.model,
  );
  if (config.model) {
    await page.getByLabel("Review before saving", { exact: true }).check();
    await page
      .getByRole("textbox", { name: "Message HomeKeeper" })
      .fill(
        "Remember this household preference: I prefer fragrance-free cleaning products. Save it as a preference.",
      );
    await page.getByRole("button", { name: "Send message" }).click();
    await page
      .getByRole("button", { name: "Confirm change", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#message").disabled,
    );
    assert.ok(
      capability.store
        .home()
        .memories.some((m) => /fragrance.free/i.test(m.content)),
    );
    await page.screenshot({
      path: `${screenshots}/conversation-alexa-theme.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Message HomeKeeper" })
      .fill("What cleaning product preference have you saved for me?");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForFunction(
      () => !document.querySelector("#message").disabled,
    );
    assert.match(
      await page.locator(".message.assistant").last().innerText(),
      /fragrance.free/i,
    );
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Desktop has no horizontal overflow",
  );
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log(
    "PASS: desktop shell, simplified item entry, uploads, one-click completion, memory correction/removal, pagination and search. Real streamed model interaction checked only when configured.",
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => hostServer.close(resolve));
  await new Promise((resolve) => capabilityServer.close(resolve));
  host.agent.close();
  capability.store.close();
  rmSync(directory, { recursive: true, force: true });
}

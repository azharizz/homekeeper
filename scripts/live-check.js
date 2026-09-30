import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createCapability } from "../capability/server.js";
import { createAgent } from "../alexa_host/agent.js";

if (
  !["NEBIUS_MODEL", "NEBIUS_API_KEY", "NEBIUS_BASE_URL"].every(
    (key) => process.env[key],
  )
) {
  console.error(
    "LIVE CHECK BLOCKED: real Nebius configuration is required. No response was simulated.",
  );
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), "homekeeper-live-"));
const token = randomUUID() + randomUUID();
const capability = createCapability({
  path: join(directory, "home.sqlite"),
  token,
});
const server = capability.app.listen(0, "127.0.0.1");
await once(server, "listening");
const capabilityUrl = `http://127.0.0.1:${server.address().port}`;
const config = {
  path: join(directory, "chat.sqlite"),
  token,
  mcpUrl: `${capabilityUrl}/mcp`,
  model: process.env.NEBIUS_MODEL,
  apiKey: process.env.NEBIUS_API_KEY,
  baseUrl: process.env.NEBIUS_BASE_URL,
  mcpTimeout: Number(process.env.MCP_REQUEST_TIMEOUT_MS || 900000),
  maxRounds: Number(process.env.MAX_AGENT_ROUNDS || 12),
};
let agent = createAgent(config);
let lastSession;
async function turn(id, input) {
  const session = await agent.run(id, input, (activity) =>
    console.log(`  ${activity}`),
  );
  lastSession = session;
  assert.notEqual(session.state, "error", session.error);
  return session;
}
async function approve(session) {
  for (let step = 0; step < 8 && session.state === "approval"; step++)
    session = await turn(session.id, { decision: true });
  assert.equal(session.state, "ready", "All requested actions must finish");
  return session;
}
try {
  console.log("CHECK: actual model proposal and rejection");
  let session = await turn(agent.create().id, {
    message:
      "This is an isolated verification home. Register a plant named Verification Monstera in the Study. Category plant. All other details are unknown.",
  });
  assert.equal(session.state, "approval");
  assert.equal(capability.store.home().assets.length, 0);
  session = await turn(session.id, { decision: false });
  assert.equal(capability.store.home().assets.length, 0);
  assert.equal(session.state, "ready");

  console.log(
    "CHECK: plant, durable memory, shopping and recurring household chore",
  );
  session = await turn(session.id, {
    message:
      "Now register Verification Monstera in the Study, category plant, unknown other fields. Also remember that the spare key is in the blue drawer. Add compost to my shopping list with no date. Add a routine called Sweep balcony, due 2026-09-21, repeating every 7 days. Please propose all four changes.",
  });
  assert.equal(session.state, "approval");
  session = await approve(session);
  let home = capability.store.home();
  assert.equal(home.assets.length, 1);
  assert.equal(home.assets[0].category.toLowerCase(), "plant");
  assert.ok(home.memories.some((m) => /blue drawer/i.test(m.content)));
  assert.ok(
    home.tasks.some(
      (t) =>
        t.kind === "shopping" && /compost/i.test(t.title) && t.due_on === null,
    ),
  );
  assert.ok(
    home.tasks.some(
      (t) => /Sweep balcony/i.test(t.title) && t.interval_days === 7,
    ),
  );
  assert.ok(
    session.messages.some(
      (m) => m.role === "tool" && m.name === "save_home_item",
    ),
  );

  console.log("CHECK: memory correction and task completion");
  const memoryId = home.memories.find((m) => /blue drawer/i.test(m.content)).id;
  session = await turn(session.id, {
    message:
      "Correction: the spare key is now in the green drawer, not the blue drawer. Update that existing memory. I bought the compost today; mark that shopping task done.",
  });
  await approve(session);
  home = capability.store.home();
  assert.equal(home.memories.length, 1, "Correction must not duplicate memory");
  assert.equal(home.memories[0].id, memoryId);
  assert.match(home.memories[0].content, /green drawer/i);
  assert.equal(home.tasks.find((t) => t.kind === "shopping").status, "done");
  assert.equal(home.task_history.length, 1);

  console.log("CHECK: recall after restart, in a new conversation");
  agent.close();
  agent = createAgent(config);
  const recall = await turn(agent.create().id, {
    message:
      "Where is my spare key, what plant is in my study, and is compost still on my open shopping list? Use current home memory.",
  });
  assert.equal(recall.state, "ready");
  assert.match(recall.messages.at(-1).content, /green drawer/i);
  assert.match(recall.messages.at(-1).content, /Monstera/i);
  assert.match(
    recall.messages.at(-1).content,
    /done|bought|completed|purchased|no longer|not.*open/i,
  );
  assert.ok(recall.contextReadAt, "Recall must read actual MCP household data");

  console.log("CHECK: real uploaded document retrieval");
  const form = new FormData();
  form.set("title", "Verification plant care note");
  form.set("kind", "other");
  form.set(
    "file",
    new Blob([
      "VERIFICATION NOTE, not manufacturer advice. Pot marker: OLIVE-73. The recorded pot size is 24 cm.",
    ]),
    "care.txt",
  );
  const upload = await fetch(
    `${capabilityUrl}/api/assets/${home.assets[0].id}/documents`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );
  assert.equal(upload.status, 201);
  const documentRead = await turn(agent.create().id, {
    message:
      "Read the uploaded Verification plant care note for my Monstera. What pot marker does it state? Cite the document and page.",
  });
  assert.equal(documentRead.state, "ready");
  assert.ok(documentRead.messages.some((m) => m.name === "read_document"));
  assert.match(documentRead.messages.at(-1).content, /OLIVE[-\u2011]73/);

  console.log("CHECK: an actual issue closes into remembered repair history");
  let repair = await turn(agent.create().id, {
    message:
      "Record this problem for Verification Monstera: its pot cracked today. This is an observed problem, not a diagnosis.",
  });
  repair = await approve(repair);
  assert.equal(capability.store.home().incidents.length, 1);
  repair = await turn(repair.id, {
    message:
      "The cracked-pot issue is resolved today. I replaced the pot with a 24 cm pot myself. Part: 24 cm pot. I paid USD 12.50. Record this repair and close the existing issue.",
  });
  await approve(repair);
  assert.equal(capability.store.home().incidents.length, 0);
  const passport = capability.store.passport(home.assets[0].id);
  assert.equal(passport.incidents[0].status, "resolved");
  assert.equal(
    passport.costs.find((c) => c.currency === "USD").total_minor,
    1250,
  );
  const repairRecall = await turn(agent.create().id, {
    message:
      "What repair did we record for my Monstera, and how much did it cost?",
  });
  assert.equal(repairRecall.state, "ready");
  assert.match(repairRecall.messages.at(-1).content, /pot/i);
  assert.match(repairRecall.messages.at(-1).content, /12[.,]50/);

  console.log("CHECK: real conversation search, without structured memory");
  await turn(agent.create().id, {
    message:
      "For discussion only, do not save a household memory: I am considering the project codename Cedar Lantern for a future reading nook. Simply acknowledge this idea without creating a record.",
  });
  const search = await turn(agent.create().id, {
    message:
      "Search my earlier conversations for the codename I considered for the reading nook. It is not in saved household memory.",
  });
  assert.equal(search.state, "ready");
  assert.ok(search.messages.some((m) => m.name === "search_conversations"));
  assert.match(search.messages.at(-1).content, /Cedar Lantern/i);
  console.log("CHECK: direct document intake with actual model filing");
  const intakeForm = new FormData();
  intakeForm.set(
    "file",
    new Blob([
      "ISOLATED TEST RECEIPT. Item name: Verification desk lamp. Category: lamp. Exact model: LAMP-INTAKE-42. Bought on 2025-06-07. No warranty terms or location provided.",
    ]),
    "verification-lamp.txt",
  );
  const intakeResponse = await fetch(`${capabilityUrl}/api/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: intakeForm,
  });
  assert.equal(intakeResponse.status, 201);
  const intake = await intakeResponse.json();
  const organized = await turn(agent.create().id, {
    message: `Read and organize this test receipt. Create its home item using the exact evidence and file the original. Do not add a maintenance schedule. Document reference: ${intake.id}`,
    execution: "direct",
  });
  assert.equal(
    organized.state,
    "ready",
    "Explicit intake completes without repeated save approvals",
  );
  assert.ok(organized.messages.some((m) => m.name === "read_document"));
  assert.ok(organized.messages.some((m) => m.name === "file_document"));
  const lamp = capability.store
    .home()
    .assets.find((a) => a.model === "LAMP-INTAKE-42");
  assert.ok(lamp);
  assert.equal(lamp.purchased_on, "2025-06-07");
  assert.equal(lamp.warranty_until, null);
  assert.equal(capability.store.readDocument(intake.id, 1).asset_id, lamp.id);
  console.log(
    "CHECK: read-only care review leaves household records unchanged",
  );
  const beforeReview = JSON.stringify(capability.store.home());
  const review = await turn(agent.create().id, {
    message: "Review my home. What needs care next?",
    execution: "direct",
    read_only: true,
  });
  assert.equal(review.state, "ready");
  assert.equal(JSON.stringify(capability.store.home()), beforeReview);
  console.log(
    "PASS: real Nebius tool selection, approval/rejection, whole-home records, corrected persistent memory, shopping completion, recurrence, restart recall, document retrieval, closed repair history, conversation search, direct document intake and read-only care review.",
  );
} catch (error) {
  console.error(
    "Verification-only tool trace:",
    JSON.stringify(
      lastSession?.messages.filter(
        (m) => m.role === "tool" || m.role === "assistant",
      ),
      null,
      2,
    ),
  );
  throw error;
} finally {
  agent.close();
  await new Promise((resolve) => server.close(resolve));
  capability.store.close();
  rmSync(directory, { recursive: true, force: true });
}

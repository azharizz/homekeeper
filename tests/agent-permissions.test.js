import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCapability } from "../capability/server.js";
import { createAgent } from "../alexa_host/agent.js";
import { execute } from "../capability/tools.js";

// Controlled provider responses exercise host authority, not model intelligence.
// Production always calls the configured Nebius endpoint; live-check covers that separately.
test("direct saves, read-only reviews and destructive decisions enforce authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "homekeeper-permissions-"));
  const token = randomUUID() + randomUUID();
  const capability = createCapability({
    path: join(directory, "home.sqlite"),
    token,
  });
  const capabilityServer = capability.app.listen(0, "127.0.0.1");
  const replies = [],
    requests = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const message = replies.shift() || {
      role: "assistant",
      content: "Test fixture finished.",
    };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
            message,
          },
        ],
      }),
    );
  });
  provider.listen(0, "127.0.0.1");
  await Promise.all([
    once(capabilityServer, "listening"),
    once(provider, "listening"),
  ]);
  const agent = createAgent({
    path: join(directory, "chat.sqlite"),
    token,
    mcpUrl: `http://127.0.0.1:${capabilityServer.address().port}/mcp`,
    model: "test-only",
    apiKey: "test-only",
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1/`,
    mcpTimeout: 900000,
    maxRounds: 6,
  });
  const call = (name, args) => ({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const memory = {
    title: "Test key location",
    content: "Test bowl",
    kind: "location",
    source: "Test user instruction",
  };
  try {
    replies.push(call("save_memory", memory));
    const direct = await agent.run(agent.create().id, {
      message: "Remember the test keys",
      execution: "direct",
    });
    assert.equal(direct.state, "ready", direct.error);
    assert.equal(capability.store.home().memories.length, 1);
    const offeredTools = requests[0].tools.map((entry) => entry.function);
    assert.ok(!offeredTools.some((entry) =>
      ["link_space_object", "save_spatial_location", "save_spatial_task",
        "schedule_spatial_maintenance"].includes(entry.name)));
    const memoryProperties = offeredTools.find((entry) => entry.name === "save_memory").parameters.properties;
    for (const field of ["space_id", "element_id", "space_revision", "space_name", "element_label"])
      assert.ok(!(field in memoryProperties));
    for (const name of ["save_task", "schedule_maintenance", "update_maintenance"]) {
      const properties = offeredTools.find((entry) => entry.name === name).parameters.properties;
      for (const field of ["space_id", "element_id", "space_revision"])
        assert.ok(!(field in properties));
    }

    replies.push(call("save_memory", { ...memory, title: "Needs review" }));
    const reviewed = await agent.run(agent.create().id, {
      message: "Remember another location",
      execution: "review",
    });
    assert.equal(reviewed.state, "approval");
    assert.equal(capability.store.home().memories.length, 1);
    await agent.run(reviewed.id, { decision: false });
    assert.equal(capability.store.home().memories.length, 1);

    const saved = capability.store.home().memories[0];
    replies.push(
      call("forget_memory", {
        memory_id: saved.id,
        expected_revision: saved.revision,
      }),
    );
    const deletion = await agent.run(agent.create().id, {
      message: "Forget that test location",
      execution: "direct",
    });
    assert.equal(deletion.state, "approval");
    assert.equal(capability.store.home().memories.length, 1);
    await agent.run(deletion.id, { decision: false });
    assert.equal(capability.store.home().memories.length, 1);

    const task = execute(capability.store, "save_task", {
      title: "Test care",
      kind: "task",
    });
    replies.push(
      call("save_task", {
        task_id: task.id,
        expected_revision: task.revision,
        title: task.title,
        kind: task.kind,
        status: "cancelled",
      }),
    );
    const cancellation = await agent.run(agent.create().id, {
      message: "Cancel test care",
      execution: "direct",
    });
    assert.equal(cancellation.state, "approval");
    assert.equal(capability.store.home().tasks[0].status, "open");

    const item = execute(capability.store, "save_home_item", {
      name: "Test fixture",
      category: "Fixture",
    });
    const plan = execute(capability.store, "schedule_maintenance", {
      asset_id: item.id,
      title: "Test plan",
      due_on: "2030-01-01",
      source: "Test user schedule",
    });
    replies.push(
      call("update_maintenance", {
        maintenance_id: plan.id,
        expected_due_on: plan.due_on,
        expected_revision: plan.revision,
        title: plan.title,
        due_on: null,
        interval_days: null,
        source: plan.source,
      }),
    );
    const stopped = await agent.run(agent.create().id, {
      message: "Stop this care plan",
      execution: "direct",
    });
    assert.equal(stopped.state, "approval");
    assert.equal(capability.store.home().maintenance.length, 1);

    await agent.run(agent.create().id, {
      message: "Review my home",
      execution: "direct",
      read_only: true,
    });
    const names = requests.at(-1).tools.map((t) => t.function.name);
    assert.deepEqual(
      names.sort(),
      [
        "get_home",
        "get_passport",
        "read_document",
        "search_conversations",
        "suggest_next_steps",
      ].sort(),
    );
    const beforeSuggestions = JSON.stringify(capability.store.home());
    const actions = ["Prepare a service brief for Test fixture"];
    replies.push(call("suggest_next_steps", { actions }));
    const suggested = await agent.run(agent.create().id, {
      message: "Review my home and suggest a next step",
      execution: "direct",
      read_only: true,
    });
    assert.equal(suggested.state, "ready");
    assert.deepEqual(suggested.nextSteps, actions);
    assert.equal(
      JSON.stringify(capability.store.home()),
      beforeSuggestions,
      "Presenting next steps never performs household actions",
    );
    const continued = await agent.run(suggested.id, {
      message: "Explain that suggestion",
    });
    assert.deepEqual(
      continued.nextSteps,
      [],
      "Old suggestions are cleared on the next request",
    );
    replies.push(
      call("save_memory", { ...memory, title: "Forbidden review write" }),
    );
    const rogue = await agent.run(agent.create().id, {
      message: "Review only",
      execution: "direct",
      read_only: true,
    });
    assert.equal(rogue.state, "error");
    assert.equal(
      capability.store.home().memories.length,
      1,
      "An unsolicited write in a read-only run is never executed",
    );
    const beforeInventedAnchor = JSON.stringify(capability.store.home());
    replies.push(call("save_spatial_location", {
      ...memory, asset_id: item.id, space_id: "a".repeat(32), element_id: "cabinet",
      space_revision: 1, space_name: "Invented", element_label: "Invented",
    }));
    const inventedAnchor = await agent.run(agent.create().id, {
      message: "Tell me where the keys are",
      execution: "direct",
    });
    assert.equal(inventedAnchor.state, "error");
    assert.equal(JSON.stringify(capability.store.home()), beforeInventedAnchor);
    const forgedPin = {
      asset_id: item.id,
      space_id: "a".repeat(32),
      element_id: "cabinet",
      space_revision: 1,
    };
    const taskPin = { ...forgedPin, title: "Invented pin", kind: "task" };
    const maintenancePin = {
      ...forgedPin, title: "Invented plan", due_on: plan.due_on, source: plan.source,
    };
    for (const [name, input] of [
      ["save_spatial_task", taskPin],
      ["schedule_spatial_maintenance", maintenancePin],
      ["save_task", taskPin],
      ["schedule_maintenance", maintenancePin],
      ["update_maintenance", {
        ...maintenancePin,
        maintenance_id: plan.id,
        expected_due_on: plan.due_on,
        expected_revision: plan.revision,
        interval_days: null,
      }],
    ]) {
      replies.push(call(name, input));
      const forged = await agent.run(agent.create().id, {
        message: "Tell me about test care",
        execution: "direct",
      });
      if (["save_task", "schedule_maintenance", "update_maintenance"].includes(name)) {
        const rejection = forged.messages.findLast(
          (message) => message.role === "tool" && message.name === name,
        );
        assert.ok(rejection, `Expected ${name} to return a validation error`);
        assert.equal(JSON.parse(rejection.content).isError, true);
      } else {
        assert.equal(forged.state, "error", `Agent cannot invoke ${name}`);
      }
      assert.equal(JSON.stringify(capability.store.home()), beforeInventedAnchor);
    }
  } finally {
    agent.close();
    await Promise.all([
      new Promise((resolve) => capabilityServer.close(resolve)),
      new Promise((resolve) => provider.close(resolve)),
    ]);
    capability.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

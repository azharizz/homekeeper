import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCapability } from "../capability/server.js";
import { createHost } from "../alexa_host/server.js";
import { guideReplay, validateGuideReplay, validateGuideContext } from "../alexa_host/guide.js";

const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).toString("base64");
const replay = { id: "aria-dino", time_seconds: 82.5 };

test("replay provenance is bounded, explicit, image-bound and incompatible with live tracking", () => {
  const input = { guide: true, message: "Describe the frame", image: { data_url: jpeg, captured_at: 100 }, guide_replay: replay };
  assert.deepEqual(validateGuideReplay(input), replay);
  assert.equal(validateGuideReplay({ guide: true, message: "Recall my keys" }), undefined);
  for (const time_seconds of [79, 83])
    assert.equal(validateGuideReplay({ ...input, guide_replay: { ...replay, time_seconds } }).time_seconds, time_seconds);
  for (const change of [{ guide: false }, { guide: undefined }, { message: undefined }, { message: " " }, { image: undefined }, { retry: true }, { retry: false }, { decision: false }])
    assert.throws(() => validateGuideReplay({ ...input, ...change }), /new Home Guide message/);
  for (const invalid of [null, {}, { ...replay, id: "other" }, { ...replay, url: "https://example.com/video.mp4" },
    ...[78.999, 83.001, NaN, Infinity, "82", null].map(time_seconds => ({ ...replay, time_seconds }))])
    assert.throws(() => validateGuideReplay({ ...input, guide_replay: invalid }), /finite source time/);
  for (const guide_context of [null, {}, { status: "tracking" }]) {
    assert.throws(() => validateGuideReplay({ ...input, guide_context }), /cannot include live tracking/);
    assert.throws(() => validateGuideContext({ ...input, guide_context }), /cannot include live tracking/);
  }
});

// Controlled HTTP provider replies assert request privacy/authority, not visual reasoning.
// The media fixture tests HTTP range semantics, not MP4 codec validity.
test("host streams fixed replay media and keeps vision/provenance in the current run only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "homekeeper-replay-"));
  const token = randomUUID() + randomUUID();
  const capability = createCapability({ path: join(directory, "home.sqlite"), token });
  const capabilityServer = capability.app.listen(0, "127.0.0.1");
  const requests = [];
  const replies = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const reply = replies.shift() || { message: { role: "assistant", content: "Test fixture answer." } };
    res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: reply.message?.tool_calls ? "tool_calls" : "stop", message: reply.message }] }));
  });
  provider.listen(0, "127.0.0.1");
  await Promise.all([once(capabilityServer, "listening"), once(provider, "listening")]);
  const capabilityUrl = `http://127.0.0.1:${capabilityServer.address().port}`;
  const config = {
    path: join(directory, "chat.sqlite"), token, capabilityUrl,
    mcpUrl: `${capabilityUrl}/mcp`, model: "text-test-only", visionModel: "vision-test-only",
    apiKey: "test-only", baseUrl: `http://127.0.0.1:${provider.address().port}/v1/`,
    mcpTimeout: 900000, maxRounds: 4, hosts: ["localhost"], guideReplayDir: directory,
  };
  const host = createHost(config);
  const server = host.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  config.hosts.push(`127.0.0.1:${server.address().port}`);
  const url = `http://127.0.0.1:${server.address().port}`;
  const turn = (id, body) => fetch(`${url}/api/conversations/${id}/turn`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const freshImage = () => ({ data_url: jpeg, captured_at: Date.now() / 1000 });
  const hasImages = request => request.messages.some(entry => Array.isArray(entry.content) && entry.content.some(part => part.type === "image_url"));
  try {
    const metadata = await fetch(`${url}/api/guide-replay`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), guideReplay);
    assert.match(metadata.headers.get("content-security-policy"), /media-src 'self' blob:;/);
    const missing = await fetch(`${url}${guideReplay.url}`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /local Aria replay clip is missing/);
    assert.equal((await fetch(`${url}${guideReplay.url}`, { method: "HEAD" })).status, 404);
    const media = Buffer.from("0123456789abcdef");
    writeFileSync(join(directory, "dino-demo-79-83-slow.mp4"), media);
    const full = await fetch(`${url}${guideReplay.url}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), media);
    const ranged = await fetch(`${url}${guideReplay.url}`, { headers: { Range: "bytes=2-5" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(await ranged.text(), "2345");
    const suffix = await fetch(`${url}${guideReplay.url}`, { headers: { Range: "bytes=-3" } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), "def");
    const head = await fetch(`${url}${guideReplay.url}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(await head.text(), "");
    const unsatisfiable = await fetch(`${url}${guideReplay.url}`, { headers: { Range: "bytes=100-200" } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal((await fetch(`${url}/api/guide-replay/other.mp4`)).status, 404);

    const id = host.agent.create().id;
    for (const change of [{ guide_context: {} }, { image: undefined }, { guide_replay: { ...replay, time_seconds: 90 } }]) {
      const invalid = await turn(id, { guide: true, message: "Describe frame", image: freshImage(), guide_replay: replay, ...change });
      assert.equal(invalid.status, 400);
      await invalid.arrayBuffer();
    }
    assert.equal(requests.length, 0);
    assert.equal(host.agent.get(id).messages.length, 0);
    replies.push({ message: { role: "assistant", content: null, tool_calls: [{
      id: randomUUID(), type: "function", function: { name: "get_home", arguments: "{}" },
    }] } });
    const image = freshImage();
    const response = await turn(id, { guide: true, message: "Describe frame", image, guide_replay: replay });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "ready");
    assert.equal(requests.length, 2, "real agent tool loop stays active");
    for (const request of requests) {
      assert.ok(hasImages(request));
    }
    const saved = JSON.stringify(host.agent.get(id));
    assert.ok(!saved.includes(jpeg) && !saved.includes("guide_replay") && !saved.includes("82.5"));
    assert.ok(host.agent.get(id).messages.filter(entry => entry.role === "user").every(entry => typeof entry.content === "string"));

    assert.equal((await host.agent.run(id, { guide: true, message: "Recall my keys" })).state, "ready");
    assert.equal(requests.at(-1).model, "text-test-only");
    assert.ok(!hasImages(requests.at(-1)));
    assert.equal((await host.agent.run(id, { guide: true, message: "Describe camera", image: freshImage() })).state, "ready");
    assert.ok(hasImages(requests.at(-1)));
    assert.equal((await host.agent.run(id, { message: "Review household" })).state, "ready");
    assert.ok(!hasImages(requests.at(-1)));

    const interrupted = host.agent.create().id;
    replies.push({ status: 503 });
    assert.equal((await host.agent.run(interrupted, { guide: true, message: "Describe interrupted frame", image: freshImage(), guide_replay: replay })).state, "error");
    assert.equal((await host.agent.run(interrupted, { retry: true })).state, "ready");
    assert.ok(!hasImages(requests.at(-1)));
  } finally {
    host.agent.close();
    await Promise.all([server, provider, capabilityServer].map(service => new Promise(resolve => service.close(resolve))));
    capability.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

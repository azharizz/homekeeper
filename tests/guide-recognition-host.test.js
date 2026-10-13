import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../alexa_host/server.js";

test("room recognition binds only fresh unique current evidence and preserves the destination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "guide-recognition-"));
  const map = "a".repeat(32), other = "b".repeat(32);
  let status = "ambiguous", revision = 2, received = 0;
  let recognitionStarted, recognitionRelease, recognitionClosed;
  const roomtrace = createServer(async (req, res) => {
    for await (const _ of req) { /* consume multipart fixture */ }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/recognize") {
      received++;
      const recognizedStatus = status;
      if (recognitionClosed) res.once("close", recognitionClosed);
      if (recognitionStarted) {
        recognitionStarted();
        await new Promise(resolve => { recognitionRelease = resolve; });
      }
      res.end(JSON.stringify({ status: recognizedStatus, map_id: recognizedStatus === "recognized" ? map : null,
        localization: recognizedStatus === "recognized" ? { map_revision: 2 } : null, reason: "fixture ambiguity" }));
    } else res.end(JSON.stringify({ id: map, name: "Living room", revision, guide_readiness: { ready: true } }));
  });
  roomtrace.listen(0, "127.0.0.1"); await once(roomtrace, "listening");
  const config = { path: join(directory, "chat.sqlite"), hosts: [], token: "fixture", roomtraceUrl: `http://127.0.0.1:${roomtrace.address().port}` };
  const host = createHost(config), server = host.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = `127.0.0.1:${server.address().port}`; config.hosts.push(address);
  const id = host.agent.create().id;
  host.agent.bindGuideRoom(id, { id: other, revision: 1, name: "Bedroom" });
  const jpeg = "data:image/jpeg;base64," + Buffer.from([255,216,255,224,255,217]).toString("base64");
  const post = (captured_at, signal) => fetch(`http://${address}/api/conversations/${id}/recognize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ image: { data_url: jpeg, captured_at } }),
  });
  try {
    assert.equal((await (await post(Date.now()/1000)).json()).status, "ambiguous");
    assert.equal(host.agent.get(id).guideSpace.id, other);
    status = "recognized"; revision = 3;
    assert.equal((await (await post(Date.now()/1000)).json()).status, "unknown");
    assert.equal(host.agent.get(id).guideSpace.id, other);
    revision = 2;
    assert.equal((await (await post(Date.now()/1000)).json()).guideSpace.id, map);
    assert.equal(host.agent.get(id).guideSpace.revision, 2);
    const started = new Promise(resolve => { recognitionStarted = resolve; });
    const delayed = post(Date.now()/1000);
    await started;
    host.agent.bindGuideRoom(id, { id: other, revision: 1, name: "Bedroom" });
    recognitionRelease();
    assert.equal((await delayed).status, 409);
    assert.equal(host.agent.get(id).guideSpace.id, other);
    const cancelledStarted = new Promise(resolve => { recognitionStarted = resolve; });
    const upstreamClosed = new Promise(resolve => { recognitionClosed = resolve; });
    const controller = new AbortController();
    const cancelled = post(Date.now()/1000, controller.signal);
    const rejected = assert.rejects(cancelled, error => error.name === "AbortError");
    await cancelledStarted;
    controller.abort();
    await rejected;
    await upstreamClosed;
    recognitionRelease();
    recognitionClosed = null;
    assert.equal(host.agent.get(id).guideSpace.id, other);
    recognitionStarted = null;
    const count = received;
    assert.equal((await post(Date.now()/1000 - 20)).status, 400);
    assert.equal(received, count);
    assert.equal(JSON.stringify(host.agent.get(id)).includes(jpeg), false);
  } finally {
    server.closeAllConnections(); roomtrace.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => roomtrace.close(resolve))]);
    host.agent.close(); rmSync(directory, { recursive: true, force: true });
  }
});

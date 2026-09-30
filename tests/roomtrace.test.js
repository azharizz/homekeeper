import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { roomtraceProxy } from "../alexa_host/roomtrace.js";

test("RoomTrace gateway streams, authenticates, prefixes redirects and reports outages", async () => {
  // Controlled HTTP peer tests transport only, not reconstruction or agent quality.
  const peer = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer server-only-token");
    assert.match(req.headers.host, /^127\.0\.0\.1:/);
    if (req.url === "/redirect") {
      res.writeHead(307, { Location: "/api/maps?q=1" });
      res.end();
    } else if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(202, { "Content-Type": req.headers["content-type"] });
      res.end(Buffer.concat(chunks));
    } else {
      res.writeHead(206, {
        "Content-Type": "model/gltf-binary",
        "Content-Disposition": 'attachment; filename="surface.glb"',
        "Content-Range": "bytes 0-3/8",
        "Cache-Control": "private, max-age=60",
      });
      res.end(Buffer.from([0, 1, 128, 255]));
    }
  }).listen(0, "127.0.0.1");
  await once(peer, "listening");
  const app = express();
  app.use(
    "/roomtrace",
    roomtraceProxy({
      roomtraceUrl: `http://127.0.0.1:${peer.address().port}`,
      token: "server-only-token",
    }),
  );
  const host = app.listen(0, "127.0.0.1");
  await once(host, "listening");
  const url = `http://127.0.0.1:${host.address().port}/roomtrace`;
  try {
    const model = await fetch(`${url}/api/maps/a/artifacts/surface.glb`, {
      headers: { Range: "bytes=0-3" },
    });
    assert.equal(model.status, 206);
    assert.deepEqual(
      Buffer.from(await model.arrayBuffer()),
      Buffer.from([0, 1, 128, 255]),
    );
    assert.equal(model.headers.get("content-range"), "bytes 0-3/8");
    assert.match(model.headers.get("content-disposition"), /surface\.glb/);
    assert.equal(model.headers.get("set-cookie"), null);
    const bytes = Buffer.alloc(14 * 1024 * 1024, 179);
    const upload = await fetch(`${url}/api/maps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: "Bearer browser-value-is-ignored",
      },
      body: bytes,
    });
    assert.equal(upload.status, 202);
    assert.deepEqual(
      Buffer.from(await upload.arrayBuffer()),
      bytes,
      "RoomTrace is not restricted to the document gateway's 13 MB limit",
    );
    const redirect = await fetch(`${url}/redirect`, { redirect: "manual" });
    assert.equal(redirect.headers.get("location"), "/roomtrace/api/maps?q=1");
    await new Promise((resolve) => peer.close(resolve));
    const unavailable = await fetch(`${url}/api/health`);
    assert.equal(unavailable.status, 503);
    assert.match(
      (await unavailable.json()).detail,
      /Start the geometry service/,
    );
    const page = await fetch(`${url}/`, { headers: { Accept: "text/html" } });
    assert.equal(page.status, 503);
    assert.match((await page.json()).detail, /Start the geometry service/);
  } finally {
    if (peer.listening) await new Promise((resolve) => peer.close(resolve));
    await new Promise((resolve) => host.close(resolve));
  }
});

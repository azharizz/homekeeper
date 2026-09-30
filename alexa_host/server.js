import express from "express";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createAgent } from "./agent.js";
import { errorHandler } from "../capability/server.js";
import { UserError } from "../capability/store.js";
import { roomtraceProxy } from "./roomtrace.js";

export function createHost(config) {
  const app = express();
  const agent = createAgent(config);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!config.hosts.includes(host))
      return res.status(403).json({ error: "This host is not allowed." });
    if (
      req.headers.origin &&
      ![`http://${host}`, `https://${host}`].includes(req.headers.origin)
    )
      return res
        .status(403)
        .json({ error: "Cross-site requests are not allowed." });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res
        .status(403)
        .json({ error: "Open HomeKeeper directly on localhost." });
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: "homekeeper-local-host" }),
  );
  app.use(
    "/roomtrace",
    roomtraceProxy({
      roomtraceUrl: config.roomtraceUrl || "http://127.0.0.1:8790",
      token: config.token,
    }),
  );
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/status", async (_req, res) => {
    let capability = false;
    try {
      capability = (await fetch(`${config.capabilityUrl}/health`)).ok;
    } catch {
      /* Expected when the capability container is unavailable. */
    }
    res.json({
      capability,
      model_configured: agent.configured(),
      model: config.model || null,
      platform: "Local host",
      amazon_connected: false,
    });
  });
  app.get("/api/conversations", (_req, res) => res.json(agent.list()));
  app.post("/api/conversations", (_req, res) =>
    res.status(201).json(agent.create()),
  );
  app.get("/api/conversations/:id", (req, res) =>
    res.json(agent.get(z.string().uuid().parse(req.params.id))),
  );
  app.post(
    "/api/conversations/:id/turn",
    express.json({ limit: "40kb" }),
    async (req, res) => {
      const input = z
        .object({
          message: z.string().trim().min(1).max(20000).optional(),
          decision: z.boolean().optional(),
          retry: z.literal(true).optional(),
          execution: z.enum(["direct", "review"]).optional(),
          read_only: z.boolean().optional(),
        })
        .refine(
          (a) =>
            [a.message, a.decision, a.retry].filter((v) => v !== undefined)
              .length === 1 &&
            (a.message !== undefined ||
              (a.execution === undefined && a.read_only === undefined)),
          "Send one message, approval decision or retry.",
        )
        .parse(req.body);
      const id = z.string().uuid().parse(req.params.id);
      if (req.get("Accept") !== "application/x-ndjson") {
        res.json(await agent.run(id, input));
        return;
      }
      res.type("application/x-ndjson");
      const emit = (value) => {
        if (!res.destroyed) res.write(`${JSON.stringify(value)}\n`);
      };
      try {
        const session = await agent.run(id, input, (text) =>
          emit({ type: "activity", text }),
        );
        emit({ type: "session", session });
      } catch (error) {
        emit({
          type: "error",
          error:
            error instanceof UserError
              ? error.message
              : "The conversation could not be continued.",
        });
      }
      res.end();
    },
  );
  app.use(
    "/api",
    express.raw({ type: () => true, limit: "13mb" }),
    async (req, res) => {
      const route = req.path;
      if (!(
        /^\/(home|export|documents)$/.test(route) ||
        /^\/assets\/[a-f\d-]+(?:\/(?:documents|report))?$/.test(route) ||
        /^\/actions\/[a-z_]+$/.test(route) ||
        /^\/documents\/[a-f\d-]+\/download$/.test(route)
      ))
        throw new UserError("Endpoint not found.", 404);
      let upstream;
      try {
        upstream = await fetch(`${config.capabilityUrl}/api${route}`, {
          method: req.method,
          headers: {
            Authorization: `Bearer ${config.token}`,
            ...(req.headers["content-type"]
              ? { "Content-Type": req.headers["content-type"] }
              : {}),
          },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        });
      } catch {
        throw new UserError(
          "The capability container is unavailable. Check Docker and try again.",
          503,
        );
      }
      for (const header of ["content-type", "content-disposition"])
        if (upstream.headers.has(header))
          res.set(header, upstream.headers.get(header));
      res
        .status(upstream.status)
        .send(Buffer.from(await upstream.arrayBuffer()));
    },
  );
  app.use(express.static(resolve("dist"), { index: "index.html" }));
  app.use(errorHandler);
  return { app, agent };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || process.env.LOCAL_HOST_PORT || 8789);
  const capabilityUrl = process.env.CAPABILITY_URL || "http://127.0.0.1:8788";
  const { app, agent } = createHost({
    path: process.env.CHAT_DB_PATH || "data/conversations.sqlite",
    token: process.env.HOMEKEEPER_TOKEN,
    capabilityUrl,
    roomtraceUrl: process.env.ROOMTRACE_URL || "http://127.0.0.1:8790",
    mcpUrl: `${capabilityUrl}/mcp`,
    model: process.env.NEBIUS_MODEL,
    apiKey: process.env.NEBIUS_API_KEY,
    baseUrl: process.env.NEBIUS_BASE_URL,
    mcpTimeout: Number(process.env.MCP_REQUEST_TIMEOUT_MS || 900000),
    maxRounds: Number(process.env.MAX_AGENT_ROUNDS || 12),
    hosts: [`localhost:${port}`, `127.0.0.1:${port}`],
  });
  const server = app.listen(port, "0.0.0.0", () =>
    console.log(`HomeKeeper local host ready on port ${port}.`),
  );
  process.on("SIGTERM", () =>
    server.close(() => {
      agent.close();
      process.exit(0);
    }),
  );
}

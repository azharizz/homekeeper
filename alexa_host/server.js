import express from "express";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createAgent } from "./agent.js";
import { errorHandler } from "../capability/server.js";
import { UserError } from "../capability/store.js";
import { roomtraceProxy } from "./roomtrace.js";
import { guideReplay, computeGuideGuidance, validateGuideImage } from "./guide.js";
import { createGuideObstacleObserver } from "./guide-obstacles.js";

export function createHost(config) {
  const app = express();
  const agent = createAgent(config);
  const observeObstacle = createGuideObstacleObserver(config);
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
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
  app.get("/api/guide-replay", (_req, res) => res.json(guideReplay));
  // A fixed local file only; Express handles HEAD, byte ranges and streaming.
  app.get("/api/guide-replay/aria.mp4", (_req, res, next) => {
    res.sendFile(resolve(config.guideReplayDir || "data/video_previews/aria", "dino-demo-79-83-slow.mp4"), error => {
      if (!error) return;
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        return next(new UserError("The local Aria replay clip is missing. Add dino-demo-79-83-slow.mp4 to GUIDE_REPLAY_DIR.", 404));
      next(error);
    });
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
  app.post("/api/guide-obstacles", express.json({ limit: "2mb" }), async (req, res) => {
    res.json(await observeObstacle(req.body));
  });
  app.post("/api/conversations/:id/recognize", express.json({ limit: "2mb" }), async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    agent.get(id);
    const generation = agent.roomGeneration(id);
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    const input = z.object({ image: z.unknown() }).strict().parse(req.body);
    const image = validateGuideImage({ guide: true, message: "Identify the current saved room", image: input.image });
    if (!image) throw new UserError("A fresh camera frame is required.");
    const body = new FormData();
    body.set("image", new Blob([Buffer.from(image.data_url.split(",")[1], "base64")], { type: "image/jpeg" }), "camera.jpg");
    body.set("captured_at", String(image.captured_at));
    const response = await fetch(`${config.roomtraceUrl || "http://127.0.0.1:8790"}/api/recognize`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}` }, body,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]), redirect: "error",
    });
    if (!response.ok) throw new UserError("Room recognition is unavailable. Stay still and try again.", 503);
    const result = await response.json();
    let current = agent.get(id);
    if (result.status === "recognized") {
      const mapId = z.string().regex(/^[a-f0-9]{32}$/).parse(result.map_id);
      if (Date.now() / 1000 - image.captured_at > 5)
        return res.json({ status: "unknown", reason: "The camera match expired. Take another view." });
      const sceneResponse = await fetch(`${config.roomtraceUrl || "http://127.0.0.1:8790"}/api/maps/${mapId}/scene`, {
        headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), redirect: "error",
      });
      if (!sceneResponse.ok) throw new UserError("The recognized room is no longer available.", 409);
      const scene = await sceneResponse.json();
      if (scene.revision !== result.localization?.map_revision || scene.guide_readiness?.ready !== true ||
          Date.now() / 1000 - image.captured_at > 5)
        return res.json({ status: "unknown", reason: "Room evidence changed or expired. Take another view." });
      if (abort.signal.aborted || res.destroyed || agent.roomGeneration(id) !== generation)
        throw new UserError("Room selection changed while recognizing. Take a new view.", 409);
      current = agent.bindGuideRoom(id, { id: mapId, revision: scene.revision, name: scene.name });
    }
    res.json({ ...result, guideSpace: current.guideSpace || null, guideTarget: current.guideTarget || null,
      guideDestination: current.guideDestination || null });
  });
  app.post("/api/conversations/:id/guidance", express.json({ limit: "8kb" }), async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = z.object({ guide_context: z.unknown() }).strict().parse(req.body);
    res.json(await computeGuideGuidance(config, agent.get(id), input.guide_context));
  });
  app.post(
    "/api/conversations/:id/turn",
    express.json({ limit: "2mb" }),
    async (req, res) => {
      const input = z
        .object({
          message: z.string().trim().min(1).max(20000).optional(),
          decision: z.boolean().optional(),
          retry: z.literal(true).optional(),
          execution: z.enum(["direct", "review"]).optional(),
          read_only: z.boolean().optional(),
          guide: z.boolean().optional(),
          image: z.unknown().optional(),
          guide_context: z.unknown().optional(),
          guide_replay: z.unknown().optional(),
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
        /^\/ui-actions\/[a-z_]+$/.test(route) ||
        /^\/documents\/[a-f\d-]+\/download$/.test(route)
      ))
        throw new UserError("Endpoint not found.", 404);
      if (req.method === "POST" &&
          /^\/ui-actions\/(link_space_object|save_spatial_task|schedule_spatial_maintenance|save_spatial_location|resolve_spatial_location)$/.test(route)) {
        let input;
        try {
          input = JSON.parse(req.body.toString());
        } catch {
          throw new UserError("Send a JSON object for this model action.");
        }
        // Clearing a stored-location anchor does not create or move a pin.
        if (route !== "/ui-actions/save_spatial_location" || input?.space_id != null) {
          const spaceId = z.string().regex(/^[a-f0-9]{32}$/).parse(input?.space_id);
          const revision = z.number().int().positive().parse(
            route === "/ui-actions/link_space_object" ? input?.revision : input?.space_revision,
          );
          let current;
          try {
            const response = await fetch(
              `${config.roomtraceUrl || "http://127.0.0.1:8790"}/api/maps/${spaceId}/architecture`,
              {
                headers: { Authorization: `Bearer ${config.token}` },
                signal: AbortSignal.timeout(5000),
                redirect: "error",
                cache: "no-store",
              },
            );
            if (response.ok) current = await response.json();
          } catch {
            // No new anchor is safe when the live model cannot be read.
          }
          if (current?.revision !== revision)
            throw new UserError(
              "The RoomTrace model is unavailable or changed. Refresh it before linking or pinning.",
              409,
            );
          if (route === "/ui-actions/resolve_spatial_location") {
            const document = current.document || current.architecture;
            const element = document?.elements?.find(value => value.id === input.element_id);
            if (!element || element.label !== input.element_label)
              throw new UserError("The selected model object changed. Read the location candidates again.", 409);
            const sceneResponse = await fetch(
              `${config.roomtraceUrl || "http://127.0.0.1:8790"}/api/maps/${spaceId}/scene`,
              { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000), redirect: "error" },
            );
            const scene = sceneResponse.ok ? await sceneResponse.json() : null;
            if (scene?.revision !== revision || scene.name !== input.space_name)
              throw new UserError("The selected room changed. Read the location candidates again.", 409);
          }
        }
      }
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
    guideReplayDir: process.env.GUIDE_REPLAY_DIR || resolve("data/video_previews/aria"),
    mcpUrl: `${capabilityUrl}/mcp`,
    model: process.env.NEBIUS_MODEL,
    visionModel: process.env.NEBIUS_VISION_MODEL,
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

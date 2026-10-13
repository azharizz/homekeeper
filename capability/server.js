import express from "express";
import multer from "multer";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { openStore, UserError } from "./store.js";
import { tools, execute, executeUiAction } from "./tools.js";

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const validation = error instanceof z.ZodError;
  const upload = error instanceof multer.MulterError;
  const status = validation || upload ? 400 : error.status || 500;
  const message = validation
    ? error.issues
        .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
        .join("; ")
    : upload
      ? "File exceeds the 12 MB upload limit."
      : status < 500 || error instanceof UserError
        ? error.message
        : "The request could not be completed. Your saved records are intact.";
  res.status(status).json({ error: message });
}

export function createCapability({ path, token }) {
  if (!token || token.length < 32)
    throw new Error(
      "HOMEKEEPER_TOKEN must contain at least 32 characters. Run npm run setup.",
    );
  const store = openStore(path);
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: "homekeeper-capability" }),
  );
  app.use((req, res, next) => {
    const provided = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      return res.status(401).json({ error: "Authentication required." });
    if (req.headers.origin)
      return res.status(403).json({ error: "Use the local HomeKeeper host." });
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/home", (_req, res) => res.json(store.home()));
  app.get("/api/assets/:id", (req, res) =>
    res.json(store.passport(z.string().uuid().parse(req.params.id))),
  );
  app.get("/api/assets/:id/report", (req, res) => {
    const item = store.passport(z.string().uuid().parse(req.params.id));
    const details = Object.entries({
      Room: item.room,
      Type: item.category,
      Manufacturer: item.brand,
      Model: item.model,
      Serial: item.serial,
      Purchased: item.purchased_on,
      "Reported warranty end": item.warranty_until,
      Notes: item.notes,
    })
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`);
    const sections = [
      [
        "Open issues",
        item.incidents
          .filter((issue) => issue.status === "open")
          .map((issue) => `${issue.opened_on}: ${issue.symptom}`),
      ],
      [
        "Care plan",
        item.maintenance
          .filter((plan) => plan.due_on)
          .map(
            (plan) =>
              `${plan.due_on}: ${plan.title}${plan.interval_days ? `, every ${plan.interval_days} days` : ""}${plan.element_label ? ` · ${plan.space_name}: ${plan.element_label}` : ""}\nSource: ${plan.source}`,
          ),
      ],
      [
        "History",
        item.events.map(
          (event) =>
            `${event.happened_on}: ${event.summary}${event.amount_display ? ` (${event.amount_display})` : ""}${event.detail ? `\n${event.detail}` : ""}`,
        ),
      ],
      ["Recorded spending", item.costs.map((cost) => cost.amount_display)],
      [
        "Saved locations",
        item.locations.map(
          (location) =>
            `${location.title}: ${location.content}${location.element_label ? ` · ${location.space_name}: ${location.element_label}` : ""}`,
        ),
      ],
      [
        "Documents on file",
        item.documents.map(
          (doc) => `${doc.title} (${doc.kind}, ${doc.page_count} pages)`,
        ),
      ],
    ];
    const report = [
      `HomeKeeper: ${item.name}`,
      ...details,
      ...sections
        .filter(([, rows]) => rows.length)
        .map(([title, rows]) => `\n${title}\n${rows.join("\n\n")}`),
      "\nHousehold records, not a diagnosis or verification of warranty coverage. Original documents are available separately in HomeKeeper.",
    ].join("\n");
    res.attachment(`homekeeper-${item.id}.txt`).type("text/plain").send(report);
  });
  app.post("/api/actions/:name", (req, res) =>
    res.json(execute(store, req.params.name, req.body)),
  );
  app.post("/api/ui-actions/:name", (req, res) =>
    res.json(executeUiAction(store, req.params.name, req.body)),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 3 },
  });
  app.post(
    ["/api/assets/:id/documents", "/api/documents"],
    upload.single("file"),
    async (req, res) => {
      const assetId = req.params.id
        ? z.string().uuid().parse(req.params.id)
        : null;
      if (assetId) store.passport(assetId);
      const title = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .parse(req.body.title || req.file?.originalname?.slice(0, 200));
      const kind = z
        .enum(["manual", "receipt", "warranty", "other"])
        .parse(req.body.kind || "other");
      if (!req.file) throw new UserError("Choose a PDF or UTF-8 text file.");
      let pages;
      let mime;
      if (req.file.buffer.subarray(0, 5).toString() === "%PDF-") {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        let loadingTask;
        try {
          loadingTask = getDocument({
            data: new Uint8Array(req.file.buffer),
            isEvalSupported: false,
            useSystemFonts: false,
            standardFontDataUrl: fileURLToPath(
              new URL(
                "../node_modules/pdfjs-dist/standard_fonts/",
                import.meta.url,
              ),
            ),
          });
          const pdf = await loadingTask.promise;
          if (pdf.numPages > 500)
            throw new UserError("Upload a document of 500 pages or fewer.");
          pages = [];
          for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();
            pages.push(
              content.items
                .map((item) => item.str + (item.hasEOL ? "\n" : " "))
                .join(""),
            );
            page.cleanup();
          }
        } catch (error) {
          if (error instanceof UserError) throw error;
          throw new UserError(
            "This PDF could not be read. Use an unlocked, searchable PDF or text file.",
          );
        } finally {
          if (loadingTask) await loadingTask.destroy();
        }
        mime = "application/pdf";
      } else {
        if (!req.file.originalname.toLowerCase().endsWith(".txt"))
          throw new UserError(
            "Only PDF and UTF-8 .txt documents are supported.",
          );
        try {
          pages = [
            new TextDecoder("utf-8", { fatal: true }).decode(req.file.buffer),
          ];
        } catch {
          throw new UserError("The text file must use UTF-8 encoding.");
        }
        if (pages[0].includes("\0"))
          throw new UserError(
            "The file contains binary data. Upload text or PDF.",
          );
        mime = "text/plain";
      }
      if (!pages.some((page) => page.trim()))
        throw new UserError(
          "No readable text found. Scanned images need OCR before upload.",
        );
      if (pages.join("").length > 2_000_000)
        throw new UserError(
          "Document text exceeds the 2 million character limit. Upload the relevant sections.",
        );
      res
        .status(201)
        .json(
          store.addDocument(assetId, title, kind, mime, req.file.buffer, pages),
        );
    },
  );
  app.get("/api/documents/:id/download", (req, res) => {
    const doc = store.document(z.string().uuid().parse(req.params.id));
    res
      .set({
        "Content-Type": doc.mime,
        "Content-Disposition": `attachment; filename="homekeeper-${doc.id}.${doc.mime === "application/pdf" ? "pdf" : "txt"}"`,
        "X-Content-Type-Options": "nosniff",
      })
      .send(Buffer.from(doc.original));
  });
  app.get("/api/export", (_req, res) => {
    const home = store.home();
    const documents = store.db
      .prepare(
        "SELECT * FROM documents UNION ALL SELECT id,NULL AS asset_id,title,kind,mime,original,pages,created_at FROM document_inbox",
      )
      .all()
      .map((doc) => ({
        ...doc,
        original_base64: Buffer.from(doc.original).toString("base64"),
        original: undefined,
        pages: JSON.parse(doc.pages),
      }));
    res.attachment("homekeeper-export.json").json({
      format: "homekeeper-v1",
      exported_at: new Date().toISOString(),
      ...home,
      passports: home.assets.map((a) => store.passport(a.id)),
      documents,
    });
  });
  app.post("/mcp", async (req, res) => {
    const server = new McpServer({ name: "HomeKeeper", version: "1.0.0" });
    for (const [name, definition] of Object.entries(tools)) {
      server.registerTool(
        name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.schema,
          annotations: {
            readOnlyHint: !definition.write,
            destructiveHint: definition.write,
            idempotentHint: !definition.write,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            const result = execute(store, name, args);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (!(error instanceof UserError || error instanceof z.ZodError))
              throw error;
            return {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) =>
    res
      .status(405)
      .set("Allow", "POST")
      .json({ error: "Use Streamable HTTP POST." }),
  );
  app.use(errorHandler);
  return { app, store };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, store } = createCapability({
    path: process.env.HOME_DB_PATH || "data/home.sqlite",
    token: process.env.HOMEKEEPER_TOKEN,
  });
  const server = app.listen(
    Number(process.env.CAPABILITY_PORT || 8788),
    "0.0.0.0",
    () => console.log("HomeKeeper capability ready."),
  );
  process.on("SIGTERM", () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
}

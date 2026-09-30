# HomeKeeper

A whole-home agent with persistent household memory. One conversation for belongings, shopping, chores, preferences, documents and repair history, backed by real Nebius reasoning and MCP tools.

## Run locally with Docker

Requires Docker Compose and Node.js 24 for setup and checks.

```sh
npm ci
npm run setup
# Edit .env privately and add your three NEBIUS values.
docker compose up --build -d
```

Open http://localhost:8789. Spaces is in the left navigation. The MCP capability endpoint is http://localhost:8788/mcp and requires the generated HOMEKEEPER_TOKEN bearer credential. Both published ports bind only to loopback. The RoomTrace geometry service stays inside the Compose network.

If your .env already exists, setup preserves its values and adds missing settings. It never prints a key. Never paste a secret into browser code or a conversation. After changing .env:

```sh
docker compose up -d --force-recreate local-host
```

Home records and forms work without a model. The conversation shows missing configuration instead of pretending to be intelligent. Set NEBIUS_MODEL to a Nebius model that supports function calling. NEBIUS_BASE_URL must be its real OpenAI-compatible API root, ending at `/v1`, not a chat-completions path. No model is hardcoded.

## Use HomeKeeper

### Spaces

Open **Spaces** in the left rail to create or open a 3D space. Its native React workspace lives under `web/spaces/`, including photo/video intake, structured architectural modeling through Codex MCP, the explicit MapAnything alternative, texture authoring, photo alignment, measurements in metres, and model walkthroughs. It uses the same typography and colors, with one HomeKeeper navigation rail. Returning to Conversation preserves your draft. Leaving Spaces stops its camera by unmounting the workspace; reopening restores the selected space.

There is one React application and one frontend build. Spaces loads on demand in HomeKeeper’s own React tree. The host streams `/roomtrace/api/` requests to the Python service, including uploads, images and GLB downloads. Household records and geometry have separate stores. Structured generation still runs through Codex using the supplied modeling request; HomeKeeper's Nebius conversation is not silently given modeling tools. There are no hosted generation APIs or Pascal connections. Estimated geometry and step counts do not establish physical accuracy or a verified walking route.

For native local execution, install the Python requirements and build HomeKeeper:

```sh
python3 -m venv .venv
.venv/bin/pip install -r features/roomtrace/requirements.txt
.venv/bin/pip install --no-deps -r features/roomtrace/requirements-engines.txt
npm ci
npm run setup
# Set ROOMTRACE_PYTHON to the absolute .venv/bin/python path in .env.
npm run build
npm run start:all
```

`npm run start:all` starts records, geometry and the host together and stops them together. `npm start`, `npm run capability` and `npm run roomtrace` start individual services. RoomTrace's native port defaults to 8790. `ROOMTRACE_URL` selects its upstream address when using a different port. Python configuration and the MCP server read HomeKeeper's root `.env`; credentials stay server-side. See [RoomTrace setup and MCP](features/roomtrace/README.md).

Local captures, revisions and asset blobs live in `features/roomtrace/data/`, which is ignored by Git and mounted into the RoomTrace container. Existing captures were copied here from the previous local workspace without changing the originals. A fresh clone contains no private home captures. Back up this directory in addition to the household/chat Docker volumes, with services stopped for a consistent backup. Downloaded engine weights live in `features/roomtrace/models/`. Setup records your local UID/GID so the non-root geometry container can write these bind-mounted directories. Run either native services or Compose against this data, not both at once.

Start in the conversation. Tell it what to remember or what you need done. For example: ask it to remember a plant's location, keep a shopping list, schedule a recurring chore, find a household contact, summarize upcoming work or recall a previous repair. These are open-ended model requests, not hardcoded routes.

Saved home items cover furniture, rooms, plants, fixtures, systems and appliances. Facts, preferences, contacts and locations have their own persistent records. Shopping and tasks can have no due date, a one-time date or a user-selected recurrence. The agent can reason, plan and draft without saving a record when that is what you ask for.

Every model step reads current household memory through the real MCP endpoint. A new conversation retains these facts. The agent can also search actual earlier conversation text. Corrections update existing memories rather than creating a second competing fact. There is no vector database or hidden canned answer path.

New browser conversations use direct saving for explicit requests. The composer checkbox, Review before saving, switches this conversation to approval mode. The API preserves review-first behavior when no mode is supplied. Removing memory, cancelling tasks and stopping maintenance always require confirmation. Read-only care reviews cannot call write tools. Completed writes survive interruptions; retried writes use idempotency keys. Approvals and tool errors are distinct outcomes. The host supplies request IDs and never treats an invented record ID as a new item.

The desktop icon rail opens compact panels for Your home, Care & tasks, Files, Memory and Home history. Lists have search and pagination. Add an item with just its name; optional identity fields stay under More details. Complete work with one click using the household date. Existing care plans can be edited without duplicating them. A passport offers a grounded service brief ready to copy and share yourself. Removing a memory removes it from active structured memory; old conversations, operation history and backups retain their copies.

For a problem with a home item, record the symptom, consult its documents and prior history, then record the actual repair. Resolution closes the issue and preserves work, parts, provider and paid costs in the same passport. This continuous history is HomeKeeper's focus, including for things with no smart-home connection.

Attach a searchable PDF or UTF-8 text file in the composer and send it to organize it. The real model reads its pages, matches or registers the physical item, and files the original using file_document. Files can be uploaded before any item exists. Removing an attachment chip removes it from that message; the uploaded original remains in Files. Uploads preserve the original and readable pages. Scanned PDFs need OCR outside the app. Costs are integer minor currency units, totalled separately per currency. Warranty dates and repair details are user-reported. Recurring work advances from the reported completion date. Saved due dates are visible when you open or ask the app; they do not trigger delivered notifications.

Click What needs care? or Review my home for an on-demand, read-only review of actual tasks, manuals, symptoms, reported warranty dates and repair spending. The model can offer up to three next-step buttons. Each button sends exactly its visible request when selected, using the conversation's normal permissions. Suggestions never execute automatically. This uses the existing Nebius tool loop. It does not run in the background or invent a health score.

Download item history from an item's History section for a plain-text record of identity, open issues, care, actual repairs, parts, providers, costs and document titles. This exports the saved facts without another model call or contacting a service provider. Original documents remain separate downloads.

The desktop theme follows the inspected Alexa website: dark canvas, blue glow, Alexa Sans typography, compact icon rail, central composer and right drawer. HomeKeeper has its own house/loop mark. Font provenance is in web/assets/README.md.

## What is actually integrated

- Real Nebius Chat Completions for reasoning and tool selection.
- Official MCP SDK, Streamable HTTP, discovered schemas, real tool calls and returned results.
- Real SQLite persistence, transactions, uploaded originals, page text and exports.
- Optional browser dictation and read-aloud use the browser's own speech implementation. Availability varies. Dictation may send audio to the browser vendor. HomeKeeper does not include an Amazon speech service.

This local host is not Amazon Alexa+. No Echo device, Amazon account, Alexa+ add-on, booking company, parts vendor or payment processor has been connected. HomeKeeper cannot search the web, verify parts compatibility, book appointments, buy parts or claim live availability. It can prepare a factual service brief and record what the user later reports. It ships no sample home and no provider mocks.

For a genuine Alexa+ deployment, follow the official onboarding links in RESEARCH_AND_PLAN.md. The capability server's data-only tools are designed for MCP clients. Public use still requires HTTPS, user identity/household isolation and an OAuth 2.1 account-linking provider. Do not tunnel this single-household local deployment and call it production Alexa+. A custom MCP App iframe is intentionally omitted; Alexa can render data-only results after real onboarding.

## Architecture and files

```text
React browser
  -> alexa_host/server.js (localhost, origin/host checks)
      -> forms/uploads -> capability/server.js
      -> agent.js -> Nebius -> MCP client -> capability/server.js
                                                -> tools.js -> store.js -> SQLite
  -> Spaces (web/spaces) -> /roomtrace/api/ -> Python API -> captures and geometry
```

`capability/` is the requested Alexa-style capability container folder. `alexa_host/` is the local conversation host. `features/roomtrace/` owns the geometry service and its tests. `web/spaces/` owns the native modeling page and scoped styles. The host retains conversation transcripts in its own volume; only the capability service owns household records. All tool definitions and direct form writes use the same validation and commands. No ORM, vector database, agent framework or graph database is needed for this scope.

The research and implementation decisions are in RESEARCH_AND_PLAN.md. Product constraints are in PRODUCT.md. The interface is documented in DESIGN.md.

## Privacy and operations

Home records, transcripts and document originals live in local Docker volumes. Current household records and the active conversation enter each Nebius request. Earlier conversation excerpts and document text enter requests when their tools are used. Do not store passwords or access codes here. No API key is returned to the browser or stored in the conversation database. This is one trusted local household, with no multi-user accounts or encryption-at-rest claim. Protect the machine and backups accordingly.

Use Export records for portable JSON including all passports and base64 original documents. For complete restoration, retain Docker-volume backups. Stop services for a consistent filesystem backup, archive both volumes, then restart. Export is one-way; JSON import is intentionally absent.

```sh
docker compose stop
mkdir -p backups
docker run --rm -v homekeeper_home-data:/data:ro -v "$PWD/backups:/backup" alpine tar czf /backup/home-data.tgz -C /data .
docker run --rm -v homekeeper_chat-data:/data:ro -v "$PWD/backups:/backup" alpine tar czf /backup/chat-data.tgz -C /data .
docker compose start
```

Restore into stopped, empty volumes by extracting the respective archive at each volume root. Backups contain private household information. Keep them outside source control. `docker compose down` preserves records. `docker compose down -v` deletes them.

MCP_REQUEST_TIMEOUT_MS is 900000 (15 minutes) because the MCP SDK requires a finite deadline. There is no added model-response timer or automatic retry. MAX_AGENT_ROUNDS bounds paid tool-loop work; reaching it preserves the transcript and offers Continue. Requests can stay active while a slow provider responds. A failed provider call returns an explicit error, never a substitute answer.

The services use non-root containers, read-only filesystems, dropped capabilities and runtime-only secrets. HTTP errors avoid exposing keys or raw provider response bodies. Uploads accept up to 12 MB and 500 PDF pages, with a 2-million-character text limit. Remote URL fetching is not offered, avoiding an unnecessary server-side request-forgery surface.

## Verification

Native Spaces has passed the HomeKeeper system and browser suites, the Python API boundary check, camera/capture/walkthrough checks, actual photo uploads, saved-model rendering and MCP calls through the host gateway. Desktop screenshots were inspected, both Docker images built, and the deployed app retained all 11 captures and existing household records. This verifies the local integration; it does not certify physical measurement accuracy, live Nebius reasoning, CUDA execution or a safe walking route. See VERIFICATION.md for the current results and historical checks.

```sh
npm test
npm run build
npm run check:browser
npm run check:roomtrace
npm run check:live
```

The live check requires actual Nebius credentials and uses an isolated temporary home, never the user database. It verifies model-selected writes, rejection, approval, household facts, corrections, shopping completion, routine scheduling, restart recall, document reads, repair history and conversation search; it cannot certify Amazon Alexa+ or external booking integrations.

The system suite covers authenticated intake, original-file preservation, atomic filing, care-plan revisions and export. The agent-permissions check uses controlled provider responses only to assert host authority, including that read-only reviews cannot mutate records. This is not evidence of model quality. The browser check covers the revised desktop, pagination and simplified interactions using an installed Google Chrome and isolated temporary databases. Run `node --env-file=.env scripts/browser-check.js` to also verify real streamed Nebius chat, approval, reload and memory recall through the browser. Set BROWSER_CHANNEL for another supported Playwright browser channel. Uploaded-document tool reads return at most 16,000 characters with page/offset continuation metadata. The UI shows when records will be sent to Nebius.

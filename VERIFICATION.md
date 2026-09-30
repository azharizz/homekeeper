# Latest revision status: built locally, tests deferred

The Alexa-themed desktop and document-intake revision on 2026-09-20 is implemented and running in local Docker. The user explicitly said, "Do entire code first until 100%. Dont test it yet!" Source implementation finished before the Docker build and attempted screenshot-only inspection. Automated and live-model tests remain unrun. No production-readiness or pixel-perfect matching claim is made for this revision.

Completed reference work: inspected the signed-in Alexa desktop with screenshots and rendered style values. The reference screenshot is saved at .impeccable/review/alexa-reference-desktop.png. Chrome blocks http://localhost:8789 with ERR_BLOCKED_BY_CLIENT, including after Reload. No browser protection was disabled. Post-change HomeKeeper screenshot inspection remains blocked. Previous HomeKeeper screenshots are evidence for the old interface only.

New source scope: Alexa-themed desktop shell and original HomeKeeper mark, locally served reference fonts, paginated/searchable side panels, compact forms, one-click completion, chat PDF/text intake, atomic document filing, editable maintenance with revision conflict checks, direct-save mode with destructive-action review, read-only care review and copyable service briefs. The follow-up adds model-selected next-request buttons and authenticated per-item history downloads. The database changes are an additive document_inbox table and maintenance revision column; existing records and IDs are retained.

Executed: source formatting, docker compose up --build -d, and container-state inspection. The Vite production build succeeded inside Docker. Both capability and local-host are running, bound to 127.0.0.1 on ports 8788 and 8789. This establishes build/start only, not functional correctness. Host-side dist was not rebuilt; Docker serves its new image's bundle.

Prepared, not executed: updated system checks including report access/content, agent authority and presentation-only suggestions, desktop browser checks and the real Nebius check. No test server or live-model call ran during this revision. Pending validation: npm test, npm run check:browser and npm run check:live, followed by desktop visual inspection when browser access is available. Inspect welcome, long conversation, attachments, proposed changes, populated/empty drawers, keyboard focus and reduced motion. Run the Impeccable detector during that validation pass. Do not reuse the older report below as evidence for the changed revision.

---

# HomeKeeper verification

Updated 2026-09-20, Asia/Jakarta. Solo implementation. The revised application was implemented before checks began; failures found by those checks were corrected. The original missing-credentials blocker is resolved.

## Running locally

- Application: http://localhost:8789
- Real MCP capability: http://localhost:8788/mcp, bearer authentication required
- Containers: homekeeper-local-host-1 and homekeeper-capability-1
- Ports bind to 127.0.0.1. Existing port 8787 was preserved.
- Persistent volumes: homekeeper_home-data and homekeeper_chat-data
- Configured model: nvidia/Nemotron-3_5-Lightning, loaded from .env
- Nebius key stays server-side. It was not printed, placed in source or bundled into the frontend.

The live and browser suites use isolated temporary households, removed afterward. A separate read-only check used the running Docker model and MCP connection, confirmed the user's home was unchanged, and removed its temporary conversation database. At that check the user's home contained zero items, memories and tasks.

## Executed checks

| Check | Result and evidence |
| --- | --- |
| Storage, API and MCP | `npm test` passed. One integration test exercises actual SQLite, HTTP servers and the official MCP client. |
| Whole-home records | Non-appliance item registration, memory creation/correction/removal, revision conflicts, shopping completion and recurring tasks passed. |
| Existing lifecycle | Incident resolution, repair history, exact money, multiple currencies, leap-day recurrence, stale completion rejection and document extraction passed. |
| Data integrity | Transactions, foreign keys, idempotent retries, changed-input rejection and database reopen passed. Legacy save_appliance remains an HTTP compatibility alias. |
| Real Nebius agent | `npm run check:live` passed against the configured remote endpoint. No model response was mocked. |
| Approval | Actual model-proposed writes remained unsaved before review. Rejection left records unchanged; approved calls executed through MCP. |
| Persistent memory | Saved a key location, corrected the same memory ID, restarted the agent and recalled the new location from a fresh conversation. |
| Household work | Registered a plant, saved shopping and a recurring balcony chore, completed shopping and retained its completion history. |
| Document grounding | Uploaded an actual text document, had the model choose read_document and verified its answer contained the document's unique marker. PDF extraction is covered by the integration check. |
| Repair continuity | Model recorded a cracked plant pot, resolved the same incident, recorded USD 12.50 once and recalled the repair and correct amount in a new conversation. |
| Earlier conversations | A model-selected search retrieved a project codename from an earlier conversation without storing it as structured household memory. |
| Browser | `node --env-file=.env scripts/browser-check.js` passed actual forms, upload, repair, money, recurrence, shopping, memory correction/removal and reload. It also exercised streamed real Nebius chat, approval, new-chat recall and restored conversation history. |
| Responsive interface | Desktop 1440px and mobile 390px inspected; no horizontal overflow or uncaught browser errors. |
| Build and containers | Production Vite build and Docker Compose build/start passed. The integration test also passed in the Node 24 production image with a read-only filesystem and no external network. |
| Docker model connection | A read-only request from the actual local-host container reached Nebius, read the actual MCP household and returned ready without changing records. |
| Security boundaries | Missing bearer token, unsafe Origin, unexpected Host and malformed input are rejected. Configured secrets were absent from the served JS/CSS bundles. |
| Impeccable review | Distill and craft-floor guidance applied. `impeccable detect --json web` returned `[]`. Manual review covered empty, populated, working and error states. This is not independent certification of all subjective catalog rules. |
| Formatting | Prettier check passed. Authored app code and updated documents contain no em dashes. |

Screenshots are in `.impeccable/review/`: desktop.png, mobile.png, passport-desktop.png, passport-mobile.png, conversation-desktop.png and conversation-mobile.png. Populated images show verification fixtures, not the user's home.

## Defects caught and corrected

The real model exposed issues that storage-only tests could not find:

- Rejection was represented as a tool failure. It now carries an explicit declined outcome and the user's recorded decision.
- Optional creation IDs were misunderstood as fields to fill. Tool contracts now explicitly require omitting new-record IDs; the host supplies idempotency keys, and invalid existing IDs stay errors.
- Current memory lacked an uploaded-document index. Actual document IDs and titles are now included, with content still read through read_document.
- Literal phrase search missed separated keywords. The real search now matches parameterized keywords within stored messages.
- The model misread a cost in minor units. Read results now include a currency-formatted amount alongside the exact storage integer.
- The model proposed an extra history entry after resolution. Contracts now explicitly state that resolution and maintenance completion already record history and costs, so repeating that work would double-count it.

Browser-check failures caused by selectors targeting hidden disclosures or ambiguous labels were corrected in the check. Model text checks allow typographic hyphen variation while still requiring the actual document marker. No required tool call or incorrect monetary result was waived.

## Scope and limits

This is a complete local single-household implementation of the described records and agent workflows. Model-selected actions and answers are probabilistic; successful checks establish the observed flows, not a guarantee that every future answer is correct. Writes remain reviewable and records remain editable.

Amazon Alexa+, Echo hardware, provider bookings, purchases, payments, live web search, device control and delivered notifications are not connected. There is no simulated substitute for those integrations. Browser microphone/audio hardware was not tested. Scanned documents need prior OCR. Warranty and repair facts are user-reported.

Current household context and active conversations are sent to Nebius. Earlier conversations and documents are retrieved as needed. A removed memory is removed from active structured memory; past conversations, operation history and backups retain their copies. The deployment trusts the local machine, has no multi-user isolation or encryption-at-rest claim, and is not intended for public exposure.

The full snapshot and transcript scan suit a household-sized dataset. Automatic context compaction and large-history indexing are absent. Export is one-way; full restoration uses the volume backup procedure in README.md. MCP uses its documented configurable 15-minute deadline. No model-response timeout or automatic provider retry was added.

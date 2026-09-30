# HomeKeeper Research and Implementation Plan

**Goal:** Deliver a working local appliance lifecycle application, with persistent facts, genuine model tool use, and a separate MCP capability container.

**Architecture:** React browser -> local conversation host -> Nebius Chat Completions -> real MCP client -> HomeKeeper capability server -> SQLite. Forms and document upload use the same capability service. Docker volumes preserve home records and conversations separately.

**Stack:** Node.js 24, React, Vite, Express, Zod, official MCP TypeScript SDK, SQLite from Node, PDF.js for document text extraction. No agent framework, vector database, graph database, scheduler, or provider mock.

**Spec:** ../RESEARCH_AGENT_RESPONSE.MD, plus the user's stricter integration and solo-work requirements.

## Research and decisions

Read the entire 1,244-line brief. Its differentiator is the complete appliance lifecycle and persistent structured facts. Registration, maintenance, issue reporting, resolution and subsequent recall are the acceptance spine. Photos, seeded appliances and provider simulation are optional examples in the brief, not evidence of user-owned assets. The current instruction explicitly prohibits fabricated paths, so the shipped database starts empty.

Two approaches were considered:

1. Native Alexa+ add-on: Amazon handles speech, reasoning and orchestration. Our MCP supplies facts and actions. This requires account onboarding, a remote endpoint and account linking for private household information.
2. Local capability host, selected: two Docker services exercise a genuine MCP connection, with the user's Nebius model performing tool selection and reasoning. The UI labels this as a local host. It does not impersonate Amazon services.

The OpenAI latest-model guide was opened and read. Its actionable guidance for this work is clear task boundaries, persistent follow-through, focused questions and appropriately scoped verification. It cannot change the model or reasoning setting of an existing Codex session. The product model remains exactly NEBIUS_MODEL from .env, not a hardcoded OpenAI replacement. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)

Amazon describes Alexa+ as a service-oriented reasoning and orchestration system. The HomeKeeper capability boundary follows that separation: the host reasons, tools own data and actions. [Amazon architecture](https://www.aboutamazon.com/news/devices/new-alexa-tech-generative-artificial-intelligence)

Alexa+ acts as an MCP client. The add-on registers tools and resources, and routes requests over Streamable HTTP. The toolkit supports the 2025-11-25 protocol and is available in the United States. Tool changes require redeployment. [MCP Toolkit overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html)

The onboarding guide requires a remotely reachable URL. Private account-linked integration requires OAuth 2.1 with PKCE and resource metadata. The local bearer token is explicitly not an implementation of Amazon account linking. Shipping a local MCP server does not establish Alexa+ certification or Echo access. [Alexa+ quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)

Tools should represent meaningful customer intents and honor all declared inputs. Return structured facts and explicit failures. Amazon can render data-only tool responses, so a custom MCP App iframe is unnecessary for this MVP. React provides the local display; Amazon would provide native rendering after genuine onboarding. [Tools and data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html)

Nebius supports OpenAI-compatible function calling. The application sends discovered MCP schemas, executes model-selected calls and returns actual results to the model. Model/provider errors remain errors, without a canned fallback. [Nebius function calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling.md)

Use the official SDK's stateless Streamable HTTP transport. Persistent application state belongs in SQLite, independent of an MCP transport session. [Official SDK example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts)

## Product contract

- Register or edit named appliances with room, category, manufacturer, exact model, serial, purchase and warranty dates, and notes. Unknown fields remain unknown.
- Read passports, open issues, scheduled maintenance, documents and event history. Warranty dates are user-entered records, not verified manufacturer coverage.
- Upload real PDF or text documents, preserve originals, extract text with page references, and retrieve it through MCP. Scanned PDFs without text explicitly need a searchable document; no invented OCR.
- Schedule maintenance with a user-supplied date and optional interval in days. Completing maintenance atomically records history and advances the schedule from the completion date.
- Record issues and resolve them with user-reported cause, work, part, provider, date and optional cost. Costs are integer minor units grouped by currency; never combine currencies.
- Conversation reads actual household tools and documents. Agent-proposed mutations require a visible approval step. Rejecting an action changes no home records. Direct form submissions are user-authorized writes.
- Persist conversations, tool results and pending confirmations. Serialise work within each conversation and deduplicate tool mutations by request identifier.
- No preloaded household, automatic diagnosis rules, fabricated manual, catalog, pricing, technician availability, booking or payment.
- Export household records and original documents for portable ownership and backup. Docker volume persistence is not itself a backup.

## Security and failure boundaries

Loopback-only published ports; private capability network; bearer authentication for MCP and capability HTTP; local host and origin checks against cross-site requests and DNS rebinding. Secrets are read only from .env at runtime, never included in frontend bundles, Docker layers, logs or exports. Uploads have a size limit and content validation at the actual file boundary. SQLite foreign keys, atomic transactions, date checks and mutation idempotency protect records.

No model, HTTP or browser request timer is added. The MCP SDK requires a request timeout, configured as MCP_REQUEST_TIMEOUT_MS=900000 in .env instead of its shorter default. MAX_AGENT_ROUNDS limits runaway paid tool loops, not elapsed time. Errors preserve completed tool results and pending decisions. No automatic model retries that could repeat paid calls or writes.

## File responsibilities and execution

- [x] capability/store.js: SQLite schema, transactions, domain queries and commands.
- [x] capability/tools.js: intent-based Zod tool contracts shared by MCP and forms.
- [x] capability/server.js: authenticated API, uploads, exports and Streamable HTTP.
- [x] alexa_host/agent.js: real Nebius/MCP loop, pending mutations and durable transcript.
- [x] alexa_host/server.js: local security boundary, React serving and capability proxy.
- [x] web/App.jsx and web/styles.css: home, passports, maintenance, timeline and conversation with explicit approvals.
- [x] Dockerfile, compose.yaml, .env.example: reproducible two-container deployment with persistent volumes and no bundled credentials.
- [x] tests/system.test.js and scripts/live-check.js: checks written and run only after full implementation, as requested.
- [x] README.md: startup, operations, platform limits and actual validation evidence.

## Verification after implementation

Run the Node test runner against an isolated temporary database. Verify the full lifecycle, exact money totals, date validation, recurrence, duplicate retries, document references and persistence across reopen. Start actual servers for authenticated MCP discovery and tool calls, unauthorized requests, unsafe origins, upload extraction and download. Test concurrent/pending action boundaries. Browser-check desktop and mobile, keyboard labels and real form workflows. Build and start Docker, then verify HTTP health and container restart persistence. If .env becomes available, run a real Nebius conversation across MCP and a fresh conversation recalling the actual test record. Keep test records out of the user's household.

Review the completed UI with the installed Impeccable craft floor and detector. Work solo, including review. Write an honest verification report distinguishing passed checks from credential-dependent checks.

## Initial execution result, superseded by the revision below

The implementation, Docker deployment and local verification are complete. See VERIFICATION.md for exact evidence. Live model verification is blocked because the three Nebius values were absent from the specified folder. No model output was substituted. Native Amazon Alexa+ onboarding and external bookings are outside the local credential-free deployment.

## Revision: whole-home agent and a simpler interface, 2026-09-20

The user rejects the appliance-only emphasis and dashboard complexity. Credentials now exist. Preserve the existing household and all passport, document, repair and maintenance data.

Two approaches: keep adding dashboard sections, or make conversation the main way to act and expose records on demand. Choose conversation with records on demand. The differentiator remains structured home memory linked to completed work, not pretending to control every device.

Implementation scope:
- Retain the real Nebius -> discovered MCP tools -> SQLite loop. Verify with actual configured model calls after implementation.
- Generalize the existing passport to any physical home item without renaming database tables or losing previous records. Keep the legacy save_appliance HTTP action as a compatibility alias; discover save_home_item through MCP.
- Add durable household memory (facts, contacts, preferences, locations) with explicit update/delete actions and provenance; add household tasks, shopping and routines with real completion history and optional links to home items.
- Provide relevant prior-conversation search as a real local tool. Load fresh structured home context before every model turn, so new conversations use saved facts without requiring the user to re-teach the house.
- Replace the dual-column dashboard with one centered conversation. One Your home button opens records, tasks, memories and item detail. Keep manual registration, document upload, issue resolution and maintenance reachable inside records. No sample household, stat blocks or setup prose on the connected home screen.
- Show progress from actual model/tool execution and concise review cards. Keep mutation authorization, idempotency and recovery.
- Finish implementation, then run store/API/MCP/browser checks and live Nebius tests covering non-appliance home objects, tasks, remembered preferences, corrections, fresh conversations and repair-history recall.

Data changes are additive tables only. Existing asset IDs and columns remain unchanged. No external booking, payment or device integration is represented without a real authorized endpoint. Physical repairs and shopping still require the user or a connected real provider to carry them out.

## Revision research and execution notes

Nebius's current function-calling interface accepts OpenAI-compatible message histories and function definitions. The application is responsible for tool execution and memory, so a single inference request is insufficient. HomeKeeper's host performs the real multi-step loop and persists both records and conversations. [Nebius function calling](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling)

The capability advertises 13 tools. The host adds one actual conversation-search tool. Creation IDs are generated by SQLite commands, while updates refer to IDs and revisions read from saved records. Tool descriptions explicitly distinguish these operations because the configured live model initially supplied placeholder IDs. Those IDs were rejected instead of silently converted into real records.

The live checks also exposed a rejected change being treated as a tool failure and an overly strict phrase-search contract. User rejection now becomes a recorded user decision, and conversation search uses parameterized keyword matching over actual transcript messages. The model still chooses searches and all household actions; no household decision rules or fabricated responses were introduced.

Existing item tables and IDs are preserved. Memory and task tables are additive. Legacy save_appliance requests map to save_home_item, with old idempotency operation names migrated to preserve retries. See VERIFICATION.md for final executed checks.

Final live verification also checked the original closed repair loop on a plant rather than an appliance. The configured model exposed two further contract gaps: minor currency units were misread during recall, and history could be proposed twice after resolving an issue. Read results now carry a native currency-formatted amount; tool descriptions explicitly explain that resolution already creates the repair history and cost. These are data representation and tool-contract fixes, not a canned decision engine. The complete live workflow subsequently passed.

## Desktop reference revision, 2026-09-20

Decision: a cosmetic recolor would leave the form burden intact. Implement a conversation-first rebuild with Alexa's observed desktop structure and real document intake. Work solo. Complete source changes before any tests; the user's latest instruction explicitly defers test execution and post-change browser verification.

Reference inspection: signed-in https://alexa.amazon.com/ screenshots show a near-black canvas, diffuse cyan/blue background, 66 px floating icon rail, 784 px centered composer, 32 px normal-weight greeting, 72 px pill input, compact suggestion pills, and a 392 px right drawer. The rendered font is Alexa Sans Text Dark. Use the public font URLs discovered in its loaded stylesheet, stored locally with source attribution. The HomeKeeper symbol is an original house/loop mark, not Amazon's logo. No Amazon affiliation claim.

Scope:
1. Replace the large records page with searchable, paginated side panels: items, care, files, memory, history, conversations and settings. One central conversation remains mounted.
2. Collapse optional item fields. Routine completion takes one click and records the actual household date. Editing and recovery retain idempotency and conflict checks.
3. Add authenticated PDF/text intake without an existing item. The real agent reads source pages, identifies or creates an item, and files the original document through an atomic MCP action. No OCR or invented identity.
4. Offer a one-click, read-only home-care review using the same real Nebius agent and stored documents/history. It assesses outstanding care, recurrence, reported warranty dates and repair spending, and asks only for essential gaps. No canned risk scores or fictional background monitoring.
5. Allow explicit record requests to run without repeated approvals. A visible per-conversation setting permits review-first; deleting memory and cancelling tasks still require review. Read-only care reviews cannot execute writes.
6. Preserve full transcripts and saved records. Paginate visual lists and conversation history. Put system details in settings and tool evidence in disclosures.
7. Update runnable checks for intake/filing, read-only authority, automatic-save boundaries and the revised desktop selectors, without running them this turn.

The original differentiator remains physical-home continuity: identity, evidence, care, symptoms, actual repairs, parts/providers and spending. Music, calendar integrations, device control, purchases and bookings remain outside the connected local scope. The OpenAI model guide was read as requested; it does not change the model or settings used by the configured Nebius endpoint. Alexa's MCP toolkit remains the architecture reference, not proof of an Amazon connection.

## Desktop implementation outcome

Source changes are complete for this revision. The capability now defines 15 tools, including file_document and update_maintenance; the host also exposes actual conversation search. Uploaded originals can wait in document_inbox and are moved atomically into the existing documents table when filed. Maintenance edits use a revision and expected due date. Existing databases receive an additive revision column, preserving prior IDs and rows.

The interface no longer exposes the old full records page or repeated completion forms. One conversation stays mounted beside a compact drawer. One shared pagination component bounds each list. Optional item fields are collapsed. The browser's direct-save setting is explicit, and the API remains review-first without a supplied mode. Destructive changes still pause. Read-only reviews filter the actual discovered tool set rather than relying on prompt wording.

No tests, build, deployment or post-change screenshots were run, following the latest request. Updated runnable checks are left for the validation phase. Prior verification applies only to the earlier implementation.

Sources re-read for this pass: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [Alexa MCP architecture](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html), and the signed-in [Alexa desktop](https://alexa.amazon.com/).

The implementation keeps conservative MCP destructive hints. Direct mode uses an explicit host-side list of permitted local record operations, with extra review for cancellations and stopping plans. New or unknown discovered writes do not inherit automatic authorization. The source checks also cover migrating an existing maintenance table and an actual Nebius intake/review flow when run later.

## Follow-up simplification, 2026-09-20

The repeated feedback calls for completing the last step from advice to action. Keep the existing Alexa reference rebuild instead of starting a second design. The two approaches considered are adding generic assistant features, or tightening the physical-home lifecycle. Choose the latter: model-selected next-step buttons and a factual per-item service history download. Neither introduces a new provider or a canned household decision engine.

Add suggest_next_steps as a host presentation tool. The real model supplies at most three complete visible requests. Nothing executes until the user selects a request; normal write permissions still apply. Keep the API read-only review filter and idempotent write behavior. A per-item text download exports factual records for the user to share, without sending anything externally or using another model call.

Continue to reduce visible prose, keep lists paginated, and preserve the actual task controls. Automated tests and live agent checks remain deferred. Source-level checks are prepared alongside changes. Docker rebuild and screenshot-only design inspection were offered as a clarification because the user also explicitly requested screenshots.

Follow-up outcome: source implementation and formatting are complete. To satisfy the existing local Docker and screenshot request, the application was rebuilt after source completion. Vite compilation passed and both Docker services are running on loopback ports 8788 and 8789. The browser screenshot attempt is blocked by Chrome's ERR_BLOCKED_BY_CLIENT on localhost, including after Reload. The signed-in Alexa reference was captured successfully. No browser protection was bypassed, no user data was added, and no automated or live-agent tests ran. See VERIFICATION.md for the exact remaining validation scope.

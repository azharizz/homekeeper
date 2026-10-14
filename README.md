<p align="center">
  <img src="submission/assets/homekeeper-banner.png" alt="homekeeper: Tell it once. Your home remembers. A household memory mapped onto a 3D model of your home, with a voice guide." width="100%">
</p>

<div align="center">
  <h1>HomeKeeper</h1>
  <p><strong>A household memory for every thing you own, mapped onto a 3D model of your home, with a voice guide that can talk you to it.</strong></p>
  <p><em>Tell it once. Your home remembers.</em></p>
  <p>
    <a href="submission/submission-description.md"><img src="https://img.shields.io/badge/SUBMISSION%20DESCRIPTION-0ABEFF?style=for-the-badge&logoColor=white" alt="Read the submission description"></a>
    <img src="https://img.shields.io/badge/ALEXA%2B%20SIMULATE-141D22?style=for-the-badge" alt="Alexa+ Simulate agent">
    <img src="https://img.shields.io/badge/3D%20SPACES%20FROM%20PHOTOS-3FF2C7?style=for-the-badge&logoColor=062030" alt="3D Spaces from photos">
  </p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3FF2C7.svg" alt="Apache 2.0 license"></a>
    <img src="https://img.shields.io/badge/React-19.3-61DAFB.svg" alt="React 19.3">
    <img src="https://img.shields.io/badge/Vite-8.3-646CFF.svg" alt="Vite 8.3">
    <img src="https://img.shields.io/badge/three.js-0.180-0ABEFF.svg" alt="three.js 0.180">
    <img src="https://img.shields.io/badge/Node.js-24-5FA04E.svg" alt="Node.js 24">
    <img src="https://img.shields.io/badge/Python-FastAPI-009688.svg" alt="Python FastAPI">
  </p>
  <p>
    <img src="https://img.shields.io/badge/agent-MCP%20tools-0ABEFF.svg" alt="MCP tools">
    <img src="https://img.shields.io/badge/memory-SQLite-1A6BFF.svg" alt="SQLite">
    <img src="https://img.shields.io/badge/geometry-COLMAP%20%2B%20Open3D-28CEEF.svg" alt="COLMAP and Open3D">
    <img src="https://img.shields.io/badge/agent-Alexa%2B%20Simulate-A9C3CF.svg" alt="Alexa+ Simulate agent">
    <img src="https://img.shields.io/badge/runs-local%20Docker%20Compose-2496ED.svg" alt="Local Docker Compose">
  </p>
  <p>
    <a href="submission/submission-description.md">Submission</a> ·
    <a href="#-the-homekeeper-loop">The loop</a> ·
    <a href="#how-the-system-is-built">Architecture</a> ·
    <a href="#-run-locally">Run locally</a> ·
    <a href="#truth-boundaries">Truth boundaries</a>
  </p>
  <p><sub>Say it → HomeKeeper saves a real record → it lands on the real object in 3D → ask, care, or be guided to it</sub></p>
</div>

> [!IMPORTANT]
> HomeKeeper runs as one trusted household on your own machine. Its assistant is labelled **Alexa+ Simulate**: our own agent, built so the same MCP tools can plug into a real Alexa+ add-on later. It is not a live Alexa+ integration. 3D models, measurements and walking steps are **estimates** (see [Truth boundaries](#truth-boundaries)).

<details>
<summary><kbd>Contents</kbd></summary>

- [At a glance](#-at-a-glance)
- [The problem](#the-problem)
- [The HomeKeeper loop](#-the-homekeeper-loop)
- [See the product](#see-the-product)
- [Five things HomeKeeper does](#five-things-homekeeper-does)
- [From photos to a 3D home](#from-photos-to-a-3d-home)
- [The Home Guide](#the-home-guide)
- [The agent and its tools](#the-agent-and-its-tools)
- [How the system is built](#how-the-system-is-built)
- [Run locally](#-run-locally)
- [Verify](#verify)
- [Privacy and operations](#privacy-and-operations)
- [Truth boundaries](#truth-boundaries)
- [Repository map](#repository-map)
- [License and attribution](#license-and-attribution)

</details>

## 🏠 At a glance

<table>
  <tr>
    <td width="20%" align="center"><strong>01 / REMEMBER</strong><br><br>“We have a stainless steel fridge with a 2-year warranty.” Said once, saved as a real record.</td>
    <td width="20%" align="center"><strong>02 / CAPTURE</strong><br><br>4 to 12 photos of a room become a 3D model you can walk and measure.</td>
    <td width="20%" align="center"><strong>03 / CONNECT</strong><br><br>Link the fridge record to the fridge in 3D. Pin the spare remote to its drawer.</td>
    <td width="20%" align="center"><strong>04 / CARE</strong><br><br>“What needs care?” answered from real records. Every change approved by you.</td>
    <td width="20%" align="center"><strong>05 / GUIDE</strong><br><br>“Put my toy in the center of the table.” Spoken steps through the 3D room.</td>
  </tr>
</table>

<p align="center">
  <img src="submission/assets/film-hero.gif" alt="The real 3D model of the apartment assembling as a hologram, then turning solid under the HomeKeeper logo" width="100%">
</p>

## The problem

A home runs on a hundred small facts nobody writes down. When does the fridge warranty end? Who fixed the leak, and what did it cost? Where is the spare remote? Which day does the fig get water?

Those facts live in drawers of receipts, scattered chats and one person’s head. Smart-home apps only know the few devices that have Wi-Fi. Notes apps know words, but nothing about *where* a thing actually is. And for anyone who cannot see the room, “it’s on the table by the TV” is not enough to find it.

HomeKeeper asks a narrower question:

> Can you tell your home something once, and have it remembered, attached to the real object, and useful the next time anyone needs it?

## ✨ The HomeKeeper loop

<p align="center">
  <img src="submission/assets/film-how.gif" alt="Animated diagram: You, the Alexa+ Simulate agent, Home memory and RoomTrace 3D over MCP, feeding records, the 3D Space and the voice guide" width="72%">
</p>

| Stage | What happens | What cannot happen silently |
| --- | --- | --- |
| **Say it** | You speak or type in one conversation. Files can be attached before any item exists. | Nothing is invented: names, dates and costs come only from you or your documents. |
| **Save it** | The Alexa+ Simulate agent reads your current home memory, then calls real MCP tools such as `save_home_item`, `save_memory`, `save_task`. | Memory removal, task cancellation and stopping care always ask first. Review mode asks for everything. |
| **Place it** | A record links to a model object in your 3D Space, or remembers a location inside it (“lower kitchen drawer, left side”). | Names never auto-link: a person confirms which object is which, per model revision. |
| **Use it** | Ask what needs care, log a repair with its real cost, or ask the Home Guide to talk you to the table. | Care reviews are enforced read-only. Guidance stops when tracking is lost or stale. |

## See the product

Every screenshot is a frame from a screen recording of the real app running locally, using the Aria apartment Space described in [License and attribution](#license-and-attribution).

### Conversation and records

| One conversation | Said once, saved | The item’s passport |
| --- | --- | --- |
| ![HomeKeeper home: What can I take care of? with voice composer and suggestions](submission/screenshots/conversation-home.jpg) | ![The fridge and fig saved from one sentence](submission/screenshots/conversation-saved.jpg) | ![Stainless steel fridge passport with details, care, files and history](submission/screenshots/item-passport.jpg) |
| The whole app starts as one calm question, over HomeKeeper’s wave-line wallpaper. | “All set.” The fridge, its warranty and a Sunday watering routine became real records. | Each thing gets a passport: identity, care, files and a chronological history. |

### Spaces: your home in 3D

| Photos in | A 3D model out | Compare with the source photo |
| --- | --- | --- |
| ![Twelve photos in the Spaces upload tray](submission/screenshots/spaces-upload.jpg) | ![Aria apartment model in Spaces](submission/screenshots/spaces-model.jpg) | ![Photos panel aligning a fisheye source photo with the model](submission/screenshots/spaces-photos.jpg) |
| 4 to 12 overlapping photos, or one video. | A structured model with walls, glazing, furniture and fittings. | Every object keeps its evidence: the real photos it came from. |

| Walk to an object | First-person walkthrough | Measure in metres |
| --- | --- | --- |
| ![Top view with a walkthrough route to the dining table](submission/screenshots/walkthrough-route.jpg) | ![First-person walkthrough view toward the dining table](submission/screenshots/walkthrough-pov.jpg) | ![Measure panel: dining table to coffee table, 3.287 m](submission/screenshots/measure.jpg) |
| “dining table · 2.69 m · about 5 steps”, from a 65 cm step length you can change. | Walk the model at eye height. | Pick two points: 3.287 m, an estimate from the model. |

### Connect, care, remember

| Link an object | Remember where it is stored | Care, by voice |
| --- | --- | --- |
| ![Objects panel linking the refrigerator to the stainless steel fridge record](submission/screenshots/link-object.jpg) | ![Storage location: spare TV remote inside the lower drawer, left side](submission/screenshots/storage-location.jpg) | ![Care review answer listing what needs care next](submission/screenshots/care-review.jpg) |
| The 3D fridge is now *the* fridge. Tasks and maintenance can be pinned to it. | The drawer is the container; the remote is the stored item. | “Review my home. What needs care next?” |

| Approve before saving | The repair, with its real cost | Memory you can correct |
| --- | --- | --- |
| ![Save to your home? approval card for the drain hose repair](submission/screenshots/care-approval.jpg) | ![Home history: Replaced drain hose, USD 85.00](submission/screenshots/home-history.jpg) | ![Editing a saved memory](submission/screenshots/memory-edit.jpg) |
| Review mode shows exactly what will change. | Symptom, cause, part, provider and $85 stay on the fridge’s record. | Every fact is inspectable and editable. |

### Home Guide

| Voice guide | Debug view: camera ⇄ 3D model |
| --- | --- |
| ![Home Guide on the Aria replay saying Be careful, three steps forward, there is a table](submission/screenshots/guide-replay.jpg) | ![Debug view: the camera frame beside the synchronized 3D model view](submission/screenshots/guide-debug.jpg) |
| Two buttons, Talk and Camera. Short spoken steps. | The same moment in the camera and in HomeKeeper’s 3D model, side by side. |

## Five things HomeKeeper does

<table>
  <tr>
    <td width="50%"><img src="submission/assets/film-remember.gif" alt="A spoken sentence becomes three record cards that fly onto the real objects in the 3D model"><br><sub><strong>1 · Remember.</strong> One sentence becomes records for the fridge, the fig and the spare remote, then each lands on its real object in 3D.</sub></td>
    <td width="50%"><img src="submission/assets/film-json.gif" alt="architecture.json typing out while each object builds in 3D"><br><sub><strong>2 · Capture.</strong> The agent writes the room as JSON; every line becomes geometry. 317 objects for the Aria apartment.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="submission/assets/film-measure.gif" alt="Two points picked on the model with the distance formula worked out to 3.287 m"><br><sub><strong>2 · Measure.</strong> Pick two points; the distance is plain geometry on the model’s coordinates.</sub></td>
    <td width="50%"><img src="submission/assets/film-connect.gif" alt="Clicking the fridge, linking it to the saved item, then the drawer opening to show the remote"><br><sub><strong>3 · Connect.</strong> Click an object, link it to a saved item, and say what is stored inside.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="submission/assets/film-care.gif" alt="Confirming the $85 drain hose repair, which flies onto the fridge"><br><sub><strong>4 · Care.</strong> Confirm the repair; the $85 drain hose joins the fridge’s history.</sub></td>
    <td width="50%"><img src="submission/assets/film-guide.gif" alt="Home Guide: phone, synchronized debug view and the 3D route to the table in front of the TV"><br><sub><strong>5 · Guide.</strong> Spoken steps, a debug view in sync with the 3D model, and the route to the table in front of the TV.</sub></td>
  </tr>
</table>

| HomeKeeper capability | What it does | Why it matters |
| --- | --- | --- |
| **One conversation** | Belongings, plants, fixtures, appliances, preferences, contacts, shopping, chores, documents and repairs, all from one composer. Voice dictation and read-aloud use the browser’s speech service. | Nobody learns a filing system. You just say it. |
| **Persistent memory over MCP** | Every model step reads current household memory through the real MCP endpoint. Earlier conversations are searchable. Corrections update existing facts instead of duplicating them. | A new conversation still knows your home. |
| **3D Spaces** | Photos or a video become a structured architectural model with photo textures, alignment, metre measurements, assets and walkthroughs. MapAnything is an alternative engine. | Your records gain a *where*. |
| **Records on real objects** | Link a model object to a saved item, pin tasks and maintenance to it, or save a storage location inside a container, then reopen it as a focused 3D view. | “Where is it?” has an answer you can see. |
| **Care with consent** | On-demand, read-only care reviews; repairs keep outcome, provider, parts and exact cost; review mode for every change. | The record stays true, and stays yours. |
| **Home Guide** | Talk and Camera. Camera stills are matched against a saved, calibrated room; the guide replans a route to the target and speaks short steps. | A home you can ask your way around. |

## From photos to a 3D home

<p align="center">
  <img src="submission/assets/film-json.gif" alt="architecture.json written by the agent, each object building in 3D" width="80%">
</p>

1. **Capture.** Add 4 to 12 overlapping photos, or one video, in **Spaces → New space**.
2. **Calibrate.** RoomTrace runs COLMAP feature tracks and estimated camera calibration. A known distance, marked in two photos, can set real scale.
3. **Author.** The structured model is written as `architecture.json` through RoomTrace’s MCP tools (from your Codex conversation): slabs, walls with openings, stairs, and every object as a box or solid in metres, each with the photos that support it.
4. **Build.** RoomTrace publishes a revision as `surface.glb`, one mesh per modeled object. Spaces renders it with three.js.
5. **Use.** Walk it, measure it, compare it with the source photos, and link its objects to your records.

```json
{ "id": "fridge_body", "kind": "box", "position": [1.04, 0.95, 6.03], "size": [0.72, 1.9, 0.68] }
```

<sub>A real element from the Aria apartment Space: a stainless refrigerator 0.72 m wide and 1.9 m tall, supported by three source photos.</sub>

**Measuring** is geometry on those coordinates. From the dining table (2.900, 0.765, 2.600) to the coffee table (6.146, 0.435, 2.200): Δx 3.246, Δy 0.330, Δz 0.400, so d = √(Δx² + Δy² + Δz²) = **3.287 m**. Like every dimension here, it is an estimate of the model, not a sensor measurement.

## The Home Guide

<p align="center">
  <img src="submission/assets/film-guide.gif" alt="Home Guide: the request, the phone guide, the synchronized debug view and the route on the 3D map" width="100%">
</p>

| Step | What happens |
| --- | --- |
| **Ask** | Tap **Talk** once for a hands-free session. Ask naturally: “I want to put my toy in the center of the table, in front of the TV.” |
| **Find the room** | With **Camera** on, fresh stills are matched against eligible calibrated Spaces on your home server. Ambiguous or incomplete matches are refused, never guessed. |
| **Find the target** | The agent resolves the destination from your saved records and the model (`read_guide_room`, `set_guide_target`, `resolve_guide_location`). |
| **Speak the route** | A local guidance endpoint replans once per second from the current pose and speaks only changed instructions: “Two steps forward.” “Be careful. Three steps forward, there is a table.” “Table ahead. Stop here.” |
| **Stay honest** | Lost or stale tracking, a changed model or a reported obstacle clears guidance. Physical clearance is never certified. |

`/?view=guide&debug=1` shows the camera frame beside a synchronized virtual view of the 3D model, the pose, the target and the route. The prerecorded demo at `/?view=guide&replay=aria` plays a **scripted** route on Aria footage, so the full experience can be seen without a calibrated room; it is labelled as a simulation in the app.

## The agent and its tools

| The Alexa+ Simulate agent can | It cannot |
| --- | --- |
| Read current household memory before every step (`get_home`, `get_passport`, `read_document`). | Invent a record, a date, a cost or a completed action. |
| Save and update records (`save_home_item`, `save_memory`, `save_task`, `schedule_maintenance`, `report_issue`, `resolve_issue`, `file_document`, `record_history`). | Delete memory, cancel a task or stop care without your confirmation. |
| Link records to 3D objects and storage locations (`link_space_object`, `save_spatial_location`, `save_spatial_task`, `schedule_spatial_maintenance`). | Decide that a model object *is* your item because the names match. |
| Search earlier conversations (`search_conversations`) and offer up to three next steps (`suggest_next_steps`). | Run a suggestion until you select it. |
| Guide: list and read rooms, set a target, rehearse a route (`list_guide_rooms`, `read_guide_room`, `set_guide_target`, `rehearse_guide_route`). | Claim a physical position without a fresh, matching camera pose. |

## How the system is built

<p align="center">
  <img src="submission/assets/homekeeper-architecture.gif" alt="Animated architecture: Remember, Capture to 3D, and Guide flows through the HomeKeeper host, the model provider and the MCP services" width="100%">
</p>

```text
React browser (Conversation · Spaces · Home Guide)
  -> alexa_host/server.js        localhost, origin/host checks, NDJSON streaming
      -> agent.js (Alexa+ Simulate agent) -> MCP client
                                    -> capability/server.js -> tools.js -> store.js -> SQLite
      -> /roomtrace/api/          -> RoomTrace (Python FastAPI): captures, geometry, GLB
  Codex conversation -> features/roomtrace/app/mcp_server.py -> structured modeling
```

| Technology | Role in HomeKeeper |
| --- | --- |
| **React 19.3 · Vite 8.3** | One frontend build: the conversation, record drawers, Spaces and the Home Guide. |
| **three.js 0.180 · React Three Fiber** | The 3D Space viewer, walkthroughs, measurement and the guide’s debug view. |
| **Node.js 24 · Express** | `alexa_host/`: the local conversation host, agent loop, guide endpoints and RoomTrace gateway. |
| **Model Context Protocol** | The official MCP SDK over Streamable HTTP between the agent and the capability server; RoomTrace exposes its own MCP tools for modeling. |
| **SQLite** | `capability/`: transactions, uploaded originals, page text, history and export. |
| **Alexa+ Simulate agent** | Reasoning and tool choice, plus vision for Home Guide camera stills. The agent model is configured in `.env`; none is hardcoded. |
| **Python · FastAPI · COLMAP · Open3D** | `features/roomtrace/`: uploads, calibration, structured geometry, localization and walkthroughs. |
| **Docker Compose** | Three services, non-root, read-only filesystems, dropped capabilities, loopback-only ports. |

## 🚀 Run locally

Requires Docker Compose, and Node.js 24 for setup and checks.

```sh
npm ci
npm run setup
# Edit .env privately and add the Alexa+ Simulate agent settings that setup lists.
docker compose up --build -d
```

Open **http://localhost:8789**. Spaces is in the left rail; the Home Guide is the beacon icon, or `/?view=guide`. The capability MCP endpoint is `http://localhost:8788/mcp` and requires the generated `HOMEKEEPER_TOKEN`. Both ports bind to loopback only; RoomTrace stays inside the Compose network.

The agent model must support function calling. Home records and forms work without a model; the conversation shows that configuration is missing instead of pretending. After changing `.env`, run `docker compose up -d --force-recreate local-host`.

<details>
<summary><strong>Native (no Docker)</strong></summary>

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

`npm run start:all` starts records, geometry and the host together. RoomTrace’s native port defaults to 8790. Run either native services or Compose against the same data, not both.

</details>

<details>
<summary><strong>Structured modeling through Codex MCP</strong></summary>

Start HomeKeeper first, then register `features/roomtrace/app/mcp_server.py` with the Python interpreter that has the RoomTrace requirements. It reads the root `.env` and calls HomeKeeper’s gateway. Spaces gives you the exact request to paste into that conversation. See [features/roomtrace/README.md](features/roomtrace/README.md).

</details>

<details>
<summary><strong>Prerecorded Aria guide demo</strong></summary>

Open `http://localhost:8789/?view=guide&replay=aria` and tap **Camera**. The slowed replay runs a scripted simulation: “Two steps forward”, “Be careful. Three steps forward, there is a table”, then “Table ahead. Stop here.” `/?view=guide&debug=1&replay=aria` shows the same timeline driving the 3D view. The host reads `data/video_previews/aria/dino-demo-79-83-slow.mp4` with its `CREDITS.txt`; set `GUIDE_REPLAY_DIR` to use another local directory.

</details>

## Verify

```sh
npm test                 # node --test tests/*.test.js
npm run build
npm run check:browser
npm run check:roomtrace
npm run check:live       # needs real agent credentials; uses an isolated temporary home
```

The system suite covers authenticated intake, original-file preservation, atomic filing, care-plan revisions and export; the permission check asserts that read-only reviews cannot write. The live check exercises model-selected writes, rejection, approval, corrections, routines, restart recall, document reads, repair history and conversation search. Results and history are in [VERIFICATION.md](VERIFICATION.md).

## Privacy and operations

- Home records, transcripts and original documents live in local Docker volumes. Current records and the active conversation are sent to the configured AI provider with each request; its retention policy applies.
- Camera stills are JPEG only, at most 1 MiB, at most ten seconds old, used for one request and never saved in chat history. RoomTrace keeps up to 64 recent localization observations locally.
- No API key reaches the browser or the conversation database. Uploads are limited to 12 MB and 500 PDF pages; remote URL fetching is not offered.
- **Export records** produces portable JSON with every passport and the original documents. For full restoration, back up the volumes:

```sh
docker compose stop
mkdir -p backups
docker run --rm -v homekeeper_home-data:/data:ro -v "$PWD/backups:/backup" alpine tar czf /backup/home-data.tgz -C /data .
docker run --rm -v homekeeper_chat-data:/data:ro -v "$PWD/backups:/backup" alpine tar czf /backup/chat-data.tgz -C /data .
docker compose start
```

`docker compose down` keeps records; `docker compose down -v` deletes them. Backups contain private household information; keep them out of source control.

## Truth boundaries

- **Alexa+ Simulate is our own agent.** No Echo device, Amazon account, Alexa+ add-on, booking company or payment processor is connected. The capability server’s MCP tools are designed to be the integration surface when real Alexa+ access exists.
- **Geometry is an estimate.** Models, dimensions and step counts come from photos and authored structure, not sensors. A model anchor is not live item tracking: HomeKeeper cannot detect that something moved.
- **One trusted household, locally.** There are no multi-user accounts or encryption-at-rest claims. Public use needs identity, authorization, HTTPS and real platform onboarding; do not tunnel this server publicly.
- **No invented data.** The app ships no sample home and no provider mocks. Dates, costs and locations come from the household.

## Repository map

```text
web/                    React app: conversation, record drawers, Home Guide
web/spaces/             Spaces: capture, 3D model, objects, measure, walkthrough
alexa_host/             Local host: agent loop, guide, RoomTrace gateway
capability/             MCP capability server and SQLite store
features/roomtrace/     Python geometry service and its MCP server
scripts/                Setup, start, browser/live/RoomTrace checks
tests/                  Node test suites
submission/             Submission description, screenshots and animations
```

Product principles are in [PRODUCT.md](PRODUCT.md), the interface in [DESIGN.md](DESIGN.md), research and integration decisions in [RESEARCH_AND_PLAN.md](RESEARCH_AND_PLAN.md).

## License and attribution

HomeKeeper is licensed under the [Apache License 2.0](LICENSE). Alexa Sans fonts are Amazon assets served locally for this interface; see [web/assets/README.md](web/assets/README.md). HomeKeeper is not endorsed by Amazon.

The demo Space and screenshots use video from the **Aria Digital Twin Dataset, Meta Reality Labs Research** ([license](https://www.projectaria.com/datasets/adt/license/)). Only the video comes from the dataset: the 3D model was generated by HomeKeeper from twelve frames of it. The dataset is licensed for non-commercial research; read `data/video_previews/aria/CREDITS.txt` before sharing anything derived from it.

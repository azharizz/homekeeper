<p align="center">
  <img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/homekeeper-banner.png" alt="homekeeper: Tell it once. Your home remembers." width="100%">
</p>

# HomeKeeper

## Tell it once. Your home remembers.

**HomeKeeper** is a household memory for every thing you own. You tell it about your home in plain words, by voice or text, and it keeps those facts as real records: the fridge and its warranty, the plant that needs Sunday water, the repair and what it cost. Then it puts them where they belong, on a **3D model of your home made from a few photos**. And for anyone who can’t see the room, a **voice Home Guide** can talk them through it, step by step.

<p align="center">
  <a href="https://github.com/azharizz/homekeeper"><img src="https://img.shields.io/badge/OPEN%20SOURCE-141D22?style=for-the-badge&logo=github&logoColor=white" alt="Source repository"></a>
  <img src="https://img.shields.io/badge/ALEXA%2B%20SIMULATE%20%C2%B7%20MCP%20TOOLS-0ABEFF?style=for-the-badge" alt="Alexa+ Simulate, MCP tools">
  <img src="https://img.shields.io/badge/3D%20SPACES%20%C2%B7%20VOICE%20GUIDE-3FF2C7?style=for-the-badge" alt="3D Spaces and voice guide">
</p>

## Inspiration

Every home runs on a hundred things we’re supposed to remember.

*Where did I put the spare remote? When was the fridge last fixed? Did anyone water the fig?* The answers live in a drawer of receipts, an old chat, or one person’s head. Smart-home apps only know the handful of devices with Wi-Fi; the sofa, the fig and the drawer are invisible to them. Notes apps remember words but know nothing about *where* anything is.

And for a person who is blind or has low vision, “it’s on the table in front of the TV” is the start of a search, not an answer.

We wanted one place you could tell your home something once, and have it remembered, attached to the real object, and useful the next time anyone needs it.

## What it does

<p align="center">
  <img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-hero.gif" alt="The 3D model of the apartment assembling as a hologram under the HomeKeeper logo" width="100%">
</p>

| HomeKeeper capability | What it does | Why it matters |
| --- | --- | --- |
| **1 · Remember, by voice** | Say “We have a stainless steel fridge, bought March 2024, with a two-year warranty.” The Alexa+ Simulate agent saves it as a real record and answers out loud. | Nobody learns a filing system. You just say it. |
| **2 · Capture your home in 3D** | 4 to 12 photos of a room become a structured 3D model: walls, windows, stairs, furniture and fittings, in metres. Walk it, measure it, compare it with the source photos. | Your records gain a *where*. |
| **3 · Connect records to real objects** | Click the fridge in 3D and link it to the fridge record. Save “spare remote: lower kitchen drawer, left side” on the drawer. | “Where is it?” has an answer you can see. |
| **4 · Care, with consent** | “What needs care?” is answered from real records. A repair keeps its symptom, part, provider and exact cost, and review mode asks before anything changes. | The record stays true, and stays yours. |
| **5 · Home Guide** | “I want to put my toy in the center of the table, in front of the TV.” HomeKeeper matches the camera to the saved room and speaks short steps: “Two steps forward… Table ahead. Stop here.” | A home you can ask your way around. |

## Product walkthrough

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-remember.gif" alt="A spoken sentence becomes record cards that fly onto the real objects in 3D"><br><sub><strong>1 · Remember.</strong> One sentence becomes three records, and each one lands on its real object in the 3D home.</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-json.gif" alt="architecture.json typing out while each object builds in 3D"><br><sub><strong>2 · Capture.</strong> The agent writes the room as JSON, and HomeKeeper builds each object from it: 317 in this apartment.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-measure.gif" alt="Two points picked on the model, distance worked out to 3.287 m"><br><sub><strong>2 · Measure.</strong> Pick two points; the distance is simple geometry on the model’s coordinates.</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-connect.gif" alt="Clicking the fridge, linking it, and the drawer opening to show the remote"><br><sub><strong>3 · Connect.</strong> Click, choose the saved item, link. Then say what is stored inside the drawer.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-care.gif" alt="Confirming the $85 drain hose repair"><br><sub><strong>4 · Care.</strong> Review the change, confirm it, and the $85 repair joins the fridge’s history.</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-guide.gif" alt="Home Guide with a synchronized debug view and the 3D route"><br><sub><strong>5 · Guide.</strong> Spoken steps, with the camera and the 3D model in sync, to the table in front of the TV.</sub></td>
  </tr>
</table>

| The conversation | The item’s passport | The 3D Space |
| --- | --- | --- |
| ![HomeKeeper conversation home](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/conversation-home.jpg) | ![Fridge passport](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/item-passport.jpg) | ![Aria apartment model in Spaces](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/spaces-model.jpg) |

| Walk to an object | Measure | Link an object |
| --- | --- | --- |
| ![Walkthrough route to the dining table](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/walkthrough-route.jpg) | ![Measure: 3.287 m](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/measure.jpg) | ![Linking the refrigerator](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/link-object.jpg) |

| Approve before saving | Home history | Home Guide debug view |
| --- | --- | --- |
| ![Save to your home? approval](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/care-approval.jpg) | ![Replaced drain hose, USD 85.00](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/home-history.jpg) | ![Camera beside the synchronized 3D view](https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/screenshots/guide-debug.jpg) |

## How the agent works

<p align="center">
  <img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-how.gif" alt="You, the Alexa+ Simulate agent, Home memory and RoomTrace 3D over MCP" width="72%">
</p>

1. You speak or type. Browser dictation turns speech into text; files can ride along.
2. The **Alexa+ Simulate agent** reads your current household memory through MCP before every step.
3. It chooses real tools: `save_home_item`, `save_memory`, `save_task`, `schedule_maintenance`, `report_issue`, `resolve_issue`, `file_document`, or the spatial ones, `link_space_object` and `save_spatial_location`.
4. Writes run directly when you asked for them, or wait for your approval in review mode. Memory removal and task cancellation always ask. Care reviews are enforced read-only.
5. HomeKeeper answers out loud, and may offer up to three next steps, which run only when you pick them.

| The agent can | The agent cannot |
| --- | --- |
| Read and update real records through MCP, and search earlier conversations. | Invent a record, a date, a cost or a completed action. |
| Link records to 3D objects and storage locations after you confirm the object. | Decide an object *is* your item because the names match. |
| Resolve a guide destination from your saved records and the 3D model. | Claim a physical position without a fresh, matching camera pose. |

## From photos to a 3D home

The Spaces feature turns 4 to 12 photos into a structured model. RoomTrace calibrates the cameras with COLMAP, and the room is authored as `architecture.json` through RoomTrace’s MCP tools: every wall, opening, stair and object, in metres, each tied to the photos that show it. A published revision becomes `surface.glb`, one mesh per object, rendered in the browser with three.js.

```json
{ "id": "fridge_body", "kind": "box", "position": [1.04, 0.95, 6.03], "size": [0.72, 1.9, 0.68] }
```

Measurement is plain geometry on those coordinates: dining table (2.900, 0.765, 2.600) to coffee table (6.146, 0.435, 2.200) gives √(3.246² + 0.330² + 0.400²) = **3.287 m**.

## How we built it

<p align="center">
  <img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/homekeeper-architecture.gif" alt="Animated architecture: Remember, Capture to 3D and Guide flows" width="100%">
</p>

| Technology | Role in HomeKeeper |
| --- | --- |
| **React 19.3 · Vite 8.3** | One frontend: conversation, record drawers, Spaces and the Home Guide. |
| **three.js · React Three Fiber** | The 3D Space viewer, walkthroughs, measurement and the guide’s debug view. |
| **Node.js 24 · Express** | The local host: agent loop, NDJSON streaming, guide endpoints, RoomTrace gateway. |
| **Model Context Protocol** | Official MCP SDK over Streamable HTTP between the agent and the household capability server; RoomTrace exposes its own MCP tools for modeling. |
| **SQLite** | Household records, transactions, original documents, history and export. |
| **Alexa+ Simulate agent** | Reasoning and tool choice, plus vision for Home Guide camera stills. No model is hardcoded. |
| **Python · FastAPI · COLMAP · Open3D** | RoomTrace: uploads, calibration, structured geometry, localization and walkthroughs. |
| **Docker Compose** | Three local services, non-root, read-only filesystems, loopback-only ports. |

## Challenges we ran into

- **Memory that stays true.** An assistant that “remembers” by guessing is worse than none. Every write goes through validated MCP tools with request IDs, revision checks and an approval path, and the agent reads current memory before each step.
- **Names are not identity.** A model object labelled “refrigerator” is not proof it is *your* fridge. Links are confirmed by a person and re-confirmed when the model revision changes.
- **Containers versus contents.** The drawer is a model object; the remote is a household item stored inside it. Keeping those roles separate made storage locations reliable.
- **Guidance without overclaiming.** Matching camera stills to a calibrated room, replanning once per second, and clearing guidance when tracking is lost or stale, while never claiming a safe path.
- **Honest Alexa+.** Without Alexa+ add-on access, we built the integration surface for real (MCP tools) and labelled the experience *Alexa+ Simulate*.

## Accomplishments we’re proud of

<p align="center">
  <img src="https://raw.githubusercontent.com/azharizz/homekeeper/main/submission/assets/film-finale.gif" alt="Every step recapped on the finished 3D home, then the HomeKeeper logo" width="80%">
</p>

- One conversation that remembers a whole home, not just its smart devices, with every change inspectable, correctable and approved.
- A 3D model of a real apartment, 317 objects generated by HomeKeeper from twelve video frames, that records can live on.
- Storage locations you can reopen as a focused 3D view, and a voice guide that uses the same model.
- A 3-minute showreel built from the real recordings and the live 3D model, with an original score and three distinct voices.

## What we learned

The most useful thing an AI can do at home is not to talk more. It is to remember exactly what you told it, show you *where*, and be honest about what it doesn’t know. The hard engineering lives in the boundaries: what may be saved without asking, what must be confirmed, and when guidance has to stop.

## What’s next

- Real Alexa+ add-on access, plugging the existing MCP tools into Alexa+.
- On-device evaluation of the Home Guide with blind and low-vision participants and mobility specialists.
- Multi-room homes with recorded doorway connections, already supported in the guide’s data model.
- Authenticated HTTPS deployment for households beyond a single local machine.

## Honest limits

- **Alexa+ Simulate** is our own agent; no live Alexa+ integration, Echo device or Amazon account is connected.
- **Geometry is an estimate.** Models, measurements and step counts come from photos and authored structure, not sensors, and a model anchor is not live item tracking.
- **Local, single household.** No multi-user accounts; not for public exposure without identity, authorization and HTTPS.

<sub>Demo footage: Aria Digital Twin Dataset, Meta Reality Labs Research ([license](https://www.projectaria.com/datasets/adt/license/)). Only the video comes from the dataset; the 3D model was generated by HomeKeeper.</sub>

## Try it

- **Source:** [github.com/azharizz/homekeeper](https://github.com/azharizz/homekeeper)
- **Run it:** `npm ci && npm run setup && docker compose up --build -d`, then open http://localhost:8789
- **Product decisions:** [PRODUCT.md](https://github.com/azharizz/homekeeper/blob/main/PRODUCT.md)
- **Verification:** [VERIFICATION.md](https://github.com/azharizz/homekeeper/blob/main/VERIFICATION.md)

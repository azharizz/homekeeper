# HomeKeeper desktop interface

The user's explicit Alexa+ reference supersedes the earlier paper/green design. The signed-in Alexa website was inspected through screenshots and rendered styles on 2026-09-20.

Use a #141d22 canvas, a quiet cyan/blue atmospheric glow, white text, #c7c8ca secondary text, #3e4349 controls, and #0abeff active accents. Locally served Alexa Sans Text Dark matches the observed type. The greeting is 32 px and regular weight. The original HomeKeeper house/loop mark uses the same cyan family.

The permanent surface is one conversation. A left icon rail opens compact right drawers. Icons have keyboard-accessible labels and visible tooltips. The central pill composer has attachment, dictation and send actions. Suggestion pills execute concrete read-only requests or focus a short draft. After a response, the model may offer up to three complete next requests as buttons. Nothing runs until selected, and existing drafts stay intact. Long chats expose earlier messages on demand. Record lists are paginated; main panels also have search.

Items open a small passport with just identity, relevant care and a chronological record. Optional identity and task scheduling fields live under More details. Care combines household tasks and item maintenance, with one-click completion. Issues are handled conversationally so repairs retain the real outcome, provider, parts and cost. Item history can be downloaded for handoff. Files can be uploaded before registration and filed by the agent. Memory is inspectable and correctable.

Review mode is visible near the composer. Requested record changes save directly in direct mode; memory removal and task cancellation require review. A care review is enforced read-only. Failed requests retain draft/progress and offer recovery.

Reference-driven exceptions to the Impeccable catalog: the atmospheric gradient, floating icon rail and pill composer are deliberate Alexa template requirements. Avoid unrelated decorative cards, dashboards, fabricated metrics, excessive headings and dense forms. Motion is limited to the ambient glow, drawer entry and actual working indicator; honor reduced motion. React remains declarative with no useEffect. No mobile-specific redesign is included.

Verification status: reference screenshots inspected before implementation. The production Docker build succeeded after source completion. Post-change screenshot-only inspection was attempted, but Chrome blocks localhost with ERR_BLOCKED_BY_CLIENT. Automated and live-agent tests are deferred. Earlier HomeKeeper screenshots and verification describe the previous revision only.

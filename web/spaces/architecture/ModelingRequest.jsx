import { CopyAction } from "../ui";

export default function ModelingRequest({ job }) {
  return (
    <section className="modeling-request">
      <h2>Your photos are ready.</h2>
      <p>
        Copy this request into Codex to create the model. This page updates when
        it is ready.
      </p>
      <CopyAction
        text={`Use RoomTrace MCP to model capture ${job.id} from its own photographs.

1. Call inspect_capture and view every reference_image. Follow the returned schema, coordinate conventions and evidence instructions. Mark estimated dimensions, contradictions and unknown areas; never invent physical measurements.
2. Author geometry from the observed shapes. Read asset_authoring_contract when arbitrary mesh topology or imported GLB is needed. Inspect saved asset evidence before reuse. Labels never select templates.
3. Publish the geometry draft with publish_architecture and the current expected_revision. Call inspect_architecture_structure for exact feature IDs; use these for measurements and photo landmarks. State face versus centerline conventions. Declare shared wall joints and connected flights/landings when observed. Review opening gaps and placement findings; structural proposals need photographic support, never automatic closure of unknown space.
4. Call inspect_architecture_materials. Select clean material patches from this capture only, target exact mesh-part IDs, and inspect each preview_photo_material image. Reject object fragments, strong lighting gradients and unsuitable repetition. Add accepted photo_materials recipes with estimated repeat lengths and provenance. Use UV-authored GLB for complex curved mappings; retain explicitly estimated materials when evidence is insufficient.
5. Publish using the latest revision, run check_architecture_geometry, and inspect the rendered model from multiple views against the references. Correct visible mapping problems before reporting completion. State any checks you could not perform.

Do not use MapAnything, room presets or hosted generation services. Do not claim photographic appearance proves physical accuracy.`}
        label="Copy modeling request"
      />
      <p className="hint">
        Codex runs from your conversation, not automatically from this page.
      </p>
    </section>
  );
}

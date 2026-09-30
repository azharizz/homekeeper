import { useQuery } from "@tanstack/react-query";
import { request } from "../api";
import { CopyAction, PageList } from "../ui";

export function StructureEvidence({ scene }) {
  const query = useQuery({
    queryKey: ["structure", scene.id, scene.revision],
    queryFn: () => request(`/maps/${scene.id}/architecture/structure`),
  });
  return (
    <details>
      <summary>Walls & opening guides</summary>
      {query.isPending && <p role="status">Calculating model relationships…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data && (
        <>
          <PageList
            items={query.data.openings}
            label="Opening guides"
            empty="No openings authored."
          >
            {(page) => (
              <ul className="issue-list">
                {page.map((o, i) => (
                  <li key={i}>
                    <strong>
                      {o.wall} ·{" "}
                      {o.opening ||
                        o.openings?.join(" / ") ||
                        "Opening without ID"}
                    </strong>
                    {Object.entries(o)
                      .filter(([key]) => key.endsWith("_m"))
                      .map(([key, value]) => (
                        <p key={key}>
                          {key.replace(/_m$/, "").replaceAll("_", " ")}:{" "}
                          {value.toFixed(3)} m
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </PageList>
          {query.data.topology.map((floor) => (
            <p key={floor.level}>
              {floor.level}: {floor.closed_boundaries.length} closed centerline
              boundaries, {floor.unconnected_endpoints.length} unconnected
              endpoints.
            </p>
          ))}
        </>
      )}
      <CopyAction
        label="Copy structural review request"
        text={`Use RoomTrace MCP inspect_architecture_structure for ${scene.id}. Inspect every source photo before proposing changes. Review exact feature references, explicit face/centerline dimensions, opening guides, shared wall joints, stair flights/landings and placement checks. Use propose_architecture_structure for supported edits, then inspect independent photo landmarks and geometry. Publish only supported changes with the current revision. Never close unobserved space or invent physical measurements.`}
      />
    </details>
  );
}

export function AccuracyEvidence({ scene }) {
  const query = useQuery({
    queryKey: ["accuracy", scene.id, scene.revision],
    queryFn: () => request(`/maps/${scene.id}/architecture/accuracy`),
  });
  const report = query.data;
  return (
    <section className="evidence" aria-label="Accuracy evidence">
      <h3>Accuracy evidence</h3>
      {query.isPending && <p role="status">Reading evidence…</p>}
      {query.error && (
        <p role="alert" className="error">
          {query.error.message}
        </p>
      )}
      {report && (
        <>
          <dl>
            <div>
              <dt>Measured distances</dt>
              <dd>{report.measurements.length || "None supplied"}</dd>
            </div>
            <div>
              <dt>Photos checked</dt>
              <dd>
                {report.photos.filter((p) => p.check_count > 0).length} /{" "}
                {report.source_views}
              </dd>
            </div>
            <div>
              <dt>Model download</dt>
              <dd>{(report.surface_bytes / 1024).toFixed(0)} KB</dd>
            </div>
            <div>
              <dt>Triangles</dt>
              <dd>{report.surface_triangles.toLocaleString()}</dd>
            </div>
          </dl>
          <PageList items={report.measurements} label="Measurements" empty="">
            {(page) => (
              <ul className="issue-list">
                {page.map((m) => (
                  <li key={m.id}>
                    <strong>{m.label}</strong>
                    <p>
                      Measured {m.distance_m.toFixed(3)} ±{" "}
                      {m.uncertainty_m.toFixed(3)} m. Model{" "}
                      {m.model_distance_m.toFixed(3)} m.
                    </p>
                    <p>
                      {m.within_reported_uncertainty ? "Within" : "Outside"}{" "}
                      reported uncertainty · Difference{" "}
                      {m.residual_m.toFixed(3)} m
                    </p>
                    <small>{m.provenance}</small>
                  </li>
                ))}
              </ul>
            )}
          </PageList>
          <p className="hint">
            Measurement checks apply to their endpoints. The rest of the room
            remains estimated.
          </p>
        </>
      )}
      <CopyAction
        text={`Inspect RoomTrace architecture ${scene.id} and inspect_architecture_accuracy through MCP. Ask me for a real measured distance, its endpoints, uncertainty and measurement method if none is supplied. Add it to measurements using the returned schema, preserving existing evidence and geometry. Report the model residual. Do not invent a physical measurement or certify the whole room.`}
        label="Copy measurement request"
      />
    </section>
  );
}

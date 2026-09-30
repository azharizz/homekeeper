import { CopyAction, PageList } from "../ui";
import { AccuracyEvidence, StructureEvidence } from "./Evidence";

export default function DetailsPanel({ scene, geometry, onIssue }) {
  const doc = scene.architecture;
  const issueCount = geometry.data?.issue_count;
  return (
    <>
      <p className="hint">
        Dimensions and photo viewpoints are estimated. This model does
        not establish surveyed physical position.
      </p>
      <AccuracyEvidence scene={scene} />
      <StructureEvidence scene={scene} />
      <h3>Geometry checks</h3>
      {geometry.isFetching && (
        <p role="status">Checking current geometry…</p>
      )}
      {geometry.error && <p role="alert">{geometry.error.message}</p>}
      <p className="hint">
        {issueCount === 0
          ? "No issues found in the targeted checks."
          : issueCount == null
            ? "Not evaluated for this revision."
            : `${issueCount} items to inspect.`}{" "}
        These checks do not establish walking clearance.
      </p>
      <PageList
        items={geometry.data?.issues || []}
        label="Geometry findings"
        empty=""
      >
        {(page) => (
          <ul className="issue-list">
            {page.map((issue, i) => (
              <li key={i}>
                <button
                  className="text-button"
                  onClick={() => onIssue(issue.elements[0])}
                >
                  {issue.elements[0]}
                </button>
                {issue.elements.length > 1 && (
                  <small>
                    {" "}
                    with {issue.elements.slice(1).join(" / ")}
                  </small>
                )}
                <p>{issue.message}</p>
                {issue.samples && (
                  <small>
                    Section overlap:{" "}
                    {Math.max(
                      ...issue.samples.map(
                        (sample) => sample.overlap_m2,
                      ),
                    ).toFixed(4)}{" "}
                    m² at sampled heights.
                  </small>
                )}
                {issue.minimum_gap_m !== undefined && (
                  <small>
                    Model gap: {issue.minimum_gap_m.toFixed(3)} m
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
      </PageList>
      <details>
        <summary>Assumptions & missing evidence</summary>
        <PageList items={doc.notes} label="Model notes" size={3}>
          {(page) => page.map((note, i) => <p key={i}>{note}</p>)}
        </PageList>
      </details>
      <CopyAction
        text={`Inspect RoomTrace architecture ${scene.id} and its geometric checks through MCP. Explain the unresolved photo/model discrepancies without claiming physical accuracy.`}
        label="Copy model review request"
      />
    </>
  );
}

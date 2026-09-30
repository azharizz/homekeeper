import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { post, request } from "../api";

export default function PlacementControls({ scene, element, group, objects }) {
  const queries = useQueryClient();
  const [second, setSecond] = useState("");
  const movable = group.every(
    (item) =>
      ["box", "solid", "asset", "rail"].includes(item.kind) && !item.attachment,
  );
  const move = useMutation({
    mutationFn: (values) =>
      post(`/maps/${scene.id}/architecture/placement`, values),
    onSuccess: () => queries.invalidateQueries(),
  });
  const measurement = useQuery({
    queryKey: ["measurement", scene.id, scene.revision, element.id, second],
    queryFn: () =>
      request(
        `/maps/${scene.id}/architecture/measure?first=${encodeURIComponent(element.id)}&second=${encodeURIComponent(second)}`,
      ),
    enabled: Boolean(second),
    retry: false,
  });
  return (
    <details>
      <summary>Move & measure</summary>
      {group.some((item) => item.attachment) && (
        <p className="hint">
          Attached to its host. Ask Codex to edit its local offsets.
        </p>
      )}
      {movable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            move.mutate({
              expected_revision: scene.revision,
              element_id: element.id,
              translation: ["x", "y", "z"].map((axis) =>
                Number(values.get(axis)),
              ),
              yaw: (Number(values.get("yaw")) * Math.PI) / 180,
            });
          }}
        >
          <p className="hint">
            Moves the whole object. X/Z: floor plane. Y: height. Metres are
            estimated.
          </p>
          <div className="placement-fields">
            {["x", "y", "z"].map((axis) => (
              <label key={axis}>
                Shift {axis.toUpperCase()}
                <input
                  name={axis}
                  type="number"
                  step="any"
                  min="-10000"
                  max="10000"
                  required
                  defaultValue="0"
                />
              </label>
            ))}
          </div>
          <label>
            Rotation (degrees)
            <input
              name="yaw"
              type="number"
              step="any"
              min="-360"
              max="360"
              required
              defaultValue="0"
            />
          </label>
          <button disabled={move.isPending}>
            {move.isPending ? "Saving placement…" : "Save placement"}
          </button>
          {move.error && (
            <p className="error" role="alert">
              {move.error.message}
            </p>
          )}
        </form>
      )}
      <label>
        Measure against
        <select
          value={second}
          onChange={(event) => setSecond(event.target.value)}
        >
          <option value="">Choose another object</option>
          {objects
            .filter((item) => item.id !== element.id && item.kind !== "zone")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.assembly || item.label}
              </option>
            ))}
        </select>
      </label>
      {measurement.isFetching && <p role="status">Measuring model geometry…</p>}
      {measurement.error && (
        <p className="error" role="alert">
          {measurement.error.message}
        </p>
      )}
      {measurement.data && (
        <>
          <dl>
            <div>
              <dt>Plan gap</dt>
              <dd>{measurement.data.plan_gap.toFixed(3)} m</dd>
            </div>
            <div>
              <dt>Height gap</dt>
              <dd>{measurement.data.height_gap.toFixed(3)} m</dd>
            </div>
            <div>
              <dt>Plan overlap</dt>
              <dd>{measurement.data.plan_overlap_area.toFixed(3)} m²</dd>
            </div>
          </dl>
          <p className="hint">
            Estimated model dimensions. Conservative component projections, not
            exact 3D collision or walking clearance.
          </p>
        </>
      )}
    </details>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api";

export function FeaturePicker({ scene, onChoose }) {
  const query = useQuery({
    queryKey: ["structure", scene.id, scene.revision],
    queryFn: () => request(`/maps/${scene.id}/architecture/structure`),
  });
  const [element, setElement] = useState("");
  const [search, setSearch] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [uv, setUV] = useState([0.5, 0.5]);
  const catalog =
    query.data?.revision === scene.revision ? query.data.features : {};
  const choices = Object.entries(catalog || {}).filter(
    ([id, entry]) =>
      entry.features.length &&
      (id === element ||
        `${entry.label} ${id}`.toLowerCase().includes(search.toLowerCase())),
  );
  const feature = catalog?.[element]?.features.find((f) => f.id === featureId);
  return (
    <details>
      <summary>Choose an exact feature</summary>
      {query.isPending && <p role="status">Loading features…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      <label>
        Find component
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or ID"
        />
      </label>
      <label>
        Component
        <select
          value={element}
          onChange={(e) => {
            setElement(e.target.value);
            setFeatureId("");
          }}
        >
          <option value="">Choose component</option>
          {choices.map(([id, entry]) => (
            <option key={id} value={id}>
              {entry.label} ({id})
            </option>
          ))}
        </select>
      </label>
      <label>
        Feature
        <select
          value={featureId}
          onChange={(e) => setFeatureId(e.target.value)}
          disabled={!element}
        >
          <option value="">Choose face or edge</option>
          {(catalog?.[element]?.features || []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.id.replaceAll(":", " · ")}
            </option>
          ))}
        </select>
      </label>
      {feature && (
        <div className="placement-fields">
          {["u", "v"]
            .filter((axis) => feature[axis].some((n) => n !== 0))
            .map((axis) => {
              const i = axis === "u" ? 0 : 1;
              return (
                <label key={axis}>
                  Fraction {axis.toUpperCase()}
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="any"
                    value={uv[i]}
                    onChange={(e) =>
                      setUV(
                        uv.map((v, j) =>
                          i === j ? Number(e.target.value) : v,
                        ),
                      )
                    }
                  />
                </label>
              );
            })}
        </div>
      )}
      <button
        disabled={
          !feature || uv.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
        }
        onClick={() =>
          onChoose({
            element_id: element,
            feature: { id: featureId, uv },
            note: `${catalog[element].label}: ${featureId}`,
            world: feature.origin.map(
              (n, i) => n + uv[0] * feature.u[i] + uv[1] * feature.v[i],
            ),
          })
        }
      >
        Use feature
      </button>
      <p className="hint">
        Fractions follow the named face or edge. Removed features block saving
        until repaired.
      </p>
    </details>
  );
}

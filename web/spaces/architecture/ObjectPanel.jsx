import { apiUrl } from "../api";
import { useState } from "react";
import { CopyAction, Icon, PageList } from "../ui";
import PlacementControls from "./PlacementControls";

export default function ObjectPanel({
  scene,
  objects,
  selected,
  element,
  group,
  focusBounds,
  onClear,
  onSelect,
  onShowPhoto,
}) {
  const [search, setSearch] = useState("");
  const doc = scene.architecture;
  const filteredObjects = objects.filter((item) =>
    `${item.assembly || item.label} ${item.kind}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <label className="search-field">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search objects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a wall, stair or object"
        />
      </label>
      {element && (
        <section className="object-inspector">
          <div className="section-row">
            <h3>{element.assembly || element.label}</h3>
            <button
              className="icon-button"
              aria-label="Clear object selection"
              onClick={onClear}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <p className="hint">
            {element.kind} ·{" "}
            {doc.levels.find((item) => item.id === element.level).name} ·{" "}
            {group.length} parts
          </p>
          {focusBounds && (
            <dl
              className="object-dimensions"
              aria-label="Estimated object dimensions in metres"
            >
              {["X span", "Height", "Z span"].map((label, i) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {(focusBounds[1][i] - focusBounds[0][i]).toFixed(3)} m
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <details>
            <summary>Photo evidence</summary>
            <p>{element.evidence}</p>
            <div className="source-links">
              {[...new Set(group.flatMap((item) => item.sources))].map(
                (name) => (
                  <button
                    key={name}
                    onClick={() => {
                      onShowPhoto(name);
                    }}
                  >
                    Photo{" "}
                    {scene.frames.findIndex((frame) => frame.name === name) + 1}
                  </button>
                ),
              )}
            </div>
          </details>
          {element.kind === "asset" && scene.assets?.[element.asset_id] && (
            <details>
              <summary>Asset source</summary>
              <p>{scene.assets[element.asset_id].description}</p>
              <p className="hint">
                {scene.assets[element.asset_id].provenance}
              </p>
              <p className="hint">
                {scene.assets[element.asset_id].dimension_basis} dimensions ·{" "}
                {scene.assets[element.asset_id].dimension_note}
              </p>
              <div className="downloads">
                <a href={apiUrl(`/assets/${element.asset_id}/model`)} download>
                  Asset GLB
                </a>
                <a
                  href={apiUrl(
                    `/assets/${element.asset_id}/model?original=true`,
                  )}
                  download
                >
                  Original GLB
                </a>
              </div>
              <CopyAction
                text={`Inspect RoomTrace asset ${element.asset_id} and its source images through MCP. Compare against object ${element.id} in map ${scene.id}. Create an improved asset with previous_asset set to the old ID, then update only this instance in a revision-checked architecture publication. Preserve evidence and mark uncertainty.`}
                label="Copy asset revision request"
              />
            </details>
          )}
          <PlacementControls
            key={`${selected}:${scene.revision}`}
            scene={scene}
            element={element}
            group={group}
            objects={objects}
          />
        </section>
      )}
      <PageList key={search} items={filteredObjects} label="Objects">
        {(page) => (
          <ul className="object-list">
            {page.map((item) => (
              <li key={item.id}>
                <button
                  aria-pressed={selected === item.id}
                  onClick={() => onSelect(item.id)}
                >
                  <span>
                    {item.assembly || item.label}
                    <small>
                      {item.kind} ·{" "}
                      {doc.levels.find((floor) => floor.id === item.level).name}
                    </small>
                  </span>
                  <Icon name="arrow" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </PageList>
      <CopyAction
        text={`Inspect and edit RoomTrace architecture ${scene.id} through MCP. Read the current revision before publishing. Preserve image evidence and explain the changes.`}
        label="Copy edit request for Codex"
      />
    </>
  );
}

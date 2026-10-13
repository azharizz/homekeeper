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
  home,
  onHomeItem,
  onHomeAction,
  targetElementId,
  onClear,
  onSelect,
  onShowPhoto,
}) {
  const [search, setSearch] = useState("");
  const [homeItemId, setHomeItemId] = useState("");
  const [storageItemId, setStorageItemId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [maintenanceTitle, setMaintenanceTitle] = useState("");
  const [maintenanceDue, setMaintenanceDue] = useState("");
  const [maintenanceInterval, setMaintenanceInterval] = useState("");
  const [maintenanceSource, setMaintenanceSource] = useState("");
  const [locationDraft, setLocationDraft] = useState(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [failedSourcePhoto, setFailedSourcePhoto] = useState("");
  const doc = scene.architecture;
  const sourceNames = [...new Set(group.flatMap((item) => item.sources))];
  const sourceFrame =
    scene.frames.find((frame) => frame.name === element?.sources?.[0]) ||
    scene.frames.find((frame) => sourceNames.includes(frame.name));
  const sourcePhoto = sourceFrame
    ? apiUrl(`/maps/${scene.id}/images/${sourceFrame.name}`)
    : "";
  const link = home?.space_objects?.find(
    (item) => item.space_id === scene.id && item.element_id === element?.id,
  );
  const linkedAsset = home?.assets?.find((item) => item.id === link?.asset_id);
  const storageAsset = home?.assets?.find((item) => item.id === storageItemId);
  const locationMemory = storageItemId && home?.memories?.find(
    (memory) =>
      memory.asset_id === storageItemId &&
      memory.kind === "location" &&
      memory.space_id === scene.id &&
      memory.element_id === element?.id,
  );
  const locationIdentity = JSON.stringify([
    scene.id, element?.id, storageItemId, locationMemory?.id, locationMemory?.content,
  ]);
  const locationDetail = locationDraft?.identity === locationIdentity
    ? locationDraft.content : locationMemory?.content || "";
  if (locationDraft && locationDraft.identity !== locationIdentity) setLocationDraft(null);
  const linkFresh = link?.revision === scene.revision;
  const selectedHomeItem = homeItemId || link?.asset_id || "";
  const filteredObjects = objects.filter((item) =>
    `${item.assembly || item.label} ${item.kind}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  async function act(action, values) {
    setWorking(true);
    setActionError("");
    setNotice("");
    try {
      await onHomeAction(action, values);
      setNotice("Saved to HomeKeeper.");
      return true;
    } catch (error) {
      setActionError(error.message);
      return false;
    } finally {
      setWorking(false);
    }
  }
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
      {targetElementId && !element && (
        <p className="error" role="alert">
          This saved model object is not in the current architecture revision.
          Choose an object from the list to continue.
        </p>
      )}
      {element && (
        <section className="object-inspector" data-element-id={element.id}>
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
          {sourcePhoto && failedSourcePhoto !== sourcePhoto ? (
            <button
              className="object-source-preview"
              aria-label={`View source photo for ${element.assembly || element.label}`}
              onClick={() => onShowPhoto(sourceFrame.name)}
            >
              <img
                key={sourcePhoto}
                src={sourcePhoto}
                alt={`Supporting capture: ${sourceFrame.original || sourceFrame.name}`}
                onError={() => setFailedSourcePhoto(sourcePhoto)}
              />
              <span>
                <Icon name="photo" size={16} />
                Source photo
                <Icon name="arrow" size={16} />
              </span>
            </button>
          ) : (
            <p className="object-source-missing hint">
              <Icon name="photo" size={18} />
              {sourcePhoto ? "Source photo unavailable" : "No source photo for this object"}
            </p>
          )}
          <p className="object-estimate hint">Estimated model dimensions · not a physical measurement</p>
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
              {sourceNames.map(
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
          <details className="record-section" open>
            <summary>HomeKeeper connection</summary>
            {link && linkedAsset ? (
              <div className="object-home-record">
                <span className="object-action-icon"><Icon name="cube" /></span>
                <div>
                  <small>HomeKeeper record</small>
                  <button
                    className="text-button"
                    disabled={!linkFresh}
                    onClick={() => onHomeItem(link.asset_id)}
                  >
                    {linkedAsset.name}
                    <Icon name="arrow" size={16} />
                  </button>
                  <small>
                    {linkFresh
                      ? [linkedAsset.room, "Open item passport"].filter(Boolean).join(" · ")
                      : `Saved revision ${link.revision} · current ${scene.revision}`}
                  </small>
                </div>
              </div>
            ) : (
              <p className="hint">Connect this object to a saved home item.</p>
            )}
            {link && !linkedAsset && (
              <p className="error" role="alert">
                The linked household item is no longer available. Choose an item to replace this link.
              </p>
            )}
            {link && !linkFresh && (
              <p className="hint">
                Review this object and confirm its item link for the current revision before opening its passport or pinning care.
              </p>
            )}
            {home?.assets?.length ? (
              <form
                className="object-link-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (selectedHomeItem)
                    void act("link_space_object", {
                      space_id: scene.id,
                      element_id: element.id,
                      asset_id: selectedHomeItem,
                      space_name: scene.name,
                      element_label: element.assembly || element.label,
                      revision: scene.revision,
                    });
                }}
              >
                <label className="field">
                  <span>Home item</span>
                  <select
                    aria-label="Home item to link"
                    value={selectedHomeItem}
                    onChange={(event) => setHomeItemId(event.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Choose a saved item
                    </option>
                    {home.assets.map((item) => (
                      <option key={item.id} value={item.id}>
                        {[item.name, item.room].filter(Boolean).join(" · ")}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondary" disabled={working}>
                  {link
                    ? "Confirm link for current model revision"
                    : "Link to home item"}
                </button>
              </form>
            ) : (
              <p className="hint">
                Add a home item in Your home before linking this object.
              </p>
            )}
            {linkFresh && linkedAsset && (
              <>
                <form
                  className="object-action-card object-task-card"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act("save_spatial_task", {
                      title: taskTitle,
                      kind: "task",
                      notes: "",
                      asset_id: link.asset_id,
                      due_on: taskDue || null,
                      interval_days: null,
                      status: "open",
                      space_id: scene.id,
                      element_id: element.id,
                      space_revision: scene.revision,
                    });
                  }}
                >
                  <h4><Icon name="check" size={18} /> Task</h4>
                  <label className="field">
                    <span>Task for {linkedAsset.name}</span>
                    <input
                      aria-label="Task for linked home item"
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      required
                      maxLength={120}
                    />
                  </label>
                  <label className="field">
                    <span>Due date (optional)</span>
                    <input
                      aria-label="Task due date"
                      type="date"
                      value={taskDue}
                      onChange={(event) => setTaskDue(event.target.value)}
                    />
                  </label>
                  <button className="secondary" disabled={working}>
                    Create pinned task
                  </button>
                </form>
                <form
                  className="object-action-card object-maintenance-card"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act("schedule_spatial_maintenance", {
                      asset_id: link.asset_id,
                      title: maintenanceTitle,
                      due_on: maintenanceDue,
                      interval_days: maintenanceInterval
                        ? Number(maintenanceInterval)
                        : null,
                      source: maintenanceSource,
                      space_id: scene.id,
                      element_id: element.id,
                      space_revision: scene.revision,
                    });
                  }}
                >
                  <h4><Icon name="plan" size={18} /> Maintenance</h4>
                  <label className="field">
                    <span>Maintenance plan</span>
                    <input
                      aria-label="Maintenance plan title"
                      value={maintenanceTitle}
                      onChange={(event) =>
                        setMaintenanceTitle(event.target.value)
                      }
                      required
                      maxLength={120}
                    />
                  </label>
                  <label className="field">
                    <span>Next due date</span>
                    <input
                      aria-label="Maintenance due date"
                      type="date"
                      value={maintenanceDue}
                      onChange={(event) =>
                        setMaintenanceDue(event.target.value)
                      }
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Repeat every (days, optional)</span>
                    <input
                      aria-label="Maintenance repeat interval in days"
                      type="number"
                      min="1"
                      max="36500"
                      value={maintenanceInterval}
                      onChange={(event) =>
                        setMaintenanceInterval(event.target.value)
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Source for this schedule</span>
                    <input
                      aria-label="Maintenance schedule source"
                      value={maintenanceSource}
                      onChange={(event) =>
                        setMaintenanceSource(event.target.value)
                      }
                      required
                      maxLength={500}
                    />
                  </label>
                  <button className="secondary" disabled={working}>
                    Pin maintenance to object
                  </button>
                </form>
              </>
            )}
            {home?.assets?.length > 0 && (
              <form
                className="object-action-card object-location-card"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!storageAsset) return;
                  void act("save_spatial_location", {
                    ...(locationMemory
                      ? {
                          memory_id: locationMemory.id,
                          expected_revision: locationMemory.revision,
                        }
                      : {}),
                    title: `${storageAsset.name} storage location`,
                    content: locationDetail,
                    kind: "location",
                    source: "Recorded by the household in Spaces",
                    asset_id: storageAsset.id,
                    space_id: scene.id,
                    element_id: element.id,
                    space_name: scene.name,
                    element_label: element.assembly || element.label,
                    space_revision: scene.revision,
                  });
                }}
              >
                <h4><Icon name="library" size={18} /> Remember a storage location</h4>
                <p className="hint">
                  This object is the container, not the item stored inside.
                </p>
                <label className="field">
                  <span>Item stored here</span>
                  <select
                    aria-label="Home item stored here"
                    value={storageItemId}
                    onChange={(event) => setStorageItemId(event.target.value)}
                    required
                  >
                    <option value="" disabled>Choose a saved item</option>
                    {home.assets.map((item) => (
                      <option key={item.id} value={item.id}>
                        {[item.name, item.room].filter(Boolean).join(" · ")}
                      </option>
                    ))}
                  </select>
                </label>
                {locationMemory && locationMemory.linked_revision !== scene.revision && (
                  <p className="hint">
                    This location was saved on an earlier model revision. Review the container and detail before updating it for the current revision.
                  </p>
                )}
                <label className="field">
                  <span>Where exactly is it stored?</span>
                  <input
                    aria-label="Storage location detail"
                    placeholder="For example, inside the lower drawer"
                    value={locationDetail}
                    onChange={(event) => setLocationDraft({ identity: locationIdentity, content: event.target.value })}
                    required
                    maxLength={500}
                  />
                </label>
                <button className="secondary" disabled={working || !storageAsset}>
                  {locationMemory ? "Update this location" : "Remember this location"}
                </button>
              </form>
            )}
            {working && <p role="status">Saving…</p>}
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
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
                  data-element-id={item.id}
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
        label="Copy edit request for Alexa+ Simulate"
      />
    </>
  );
}

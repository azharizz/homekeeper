import React, { useEffect, useRef, useState } from "react";

const endpointKey = endpoint => `${endpoint.element_id}:${endpoint.opening_id}`;
const freshQuery = (scene, tracking, now) => scene && tracking?.status === "tracking" &&
  tracking.mapId === scene.id && tracking.revision === scene.revision &&
  typeof tracking.queryId === "string" && tracking.queryId.length > 0 &&
  Number.isFinite(tracking.queryCapturedAt) && tracking.queryCapturedAt <= now && now - tracking.queryCapturedAt <= 5 &&
  Number.isFinite(tracking.capturedAt) && tracking.capturedAt <= now && now - tracking.capturedAt <= 5;

export default function GuideConnections({ request, scene, tracking, onMessage }) {
  const [model, setModel] = useState(null), [opening, setOpening] = useState(""), [floor, setFloor] = useState("");
  const [first, setFirst] = useState(null), [second, setSecond] = useState(null), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [now, setNow] = useState(() => Date.now() / 1000);
  const generation = useRef(0), alive = useRef(true), current = useRef({ scene, tracking });
  current.current = { scene, tracking };
  const endpoint = model?.endpoints.find(value => endpointKey(value) === opening);
  const floors = endpoint?.floor_ids || [];
  const fresh = freshQuery(scene, tracking, now);
  const available = model?.map_id === scene?.id && model?.revision === scene?.revision &&
    endpoint && floors.includes(floor) && fresh;

  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => { alive.current = false; generation.current++; clearInterval(timer); };
  }, []);
  useEffect(() => {
    const run = ++generation.current, abort = new AbortController();
    setModel(null); setOpening(""); setFloor(""); setSecond(null); setBusy(false);
    if (!scene?.id) return () => abort.abort();
    request(`/maps/${scene.id}/connection-endpoints`, { signal: abort.signal }).then(value => {
      if (!alive.current || abort.signal.aborted || generation.current !== run) return;
      if (value.map_id !== scene.id || value.revision !== scene.revision || !Array.isArray(value.endpoints))
        throw new Error("Current doorway evidence is unavailable. Refresh the room.");
      setModel(value);
      if (!value.endpoints.length) setMessage(value.reason || "This model has no authored doorway endpoints.");
    }).catch(error => {
      if (alive.current && !abort.signal.aborted && generation.current === run) setMessage(error.message);
    });
    return () => abort.abort();
  }, [request, scene?.id, scene?.revision]);
  useEffect(() => {
    if (first && ((scene && tracking?.mapId === scene.id && ["stopped", "unsupported"].includes(tracking?.status)) ||
        (scene?.id === first.ref.map_id && scene.revision !== first.ref.revision))) {
      generation.current++; setFirst(null); setSecond(null); setBusy(false);
    }
  }, [tracking?.status, scene?.id, scene?.revision, first]);
  useEffect(() => {
    const clear = () => { if (document.hidden) { generation.current++; setFirst(null); setSecond(null); setBusy(false); } };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);

  function notify(text) { setMessage(text); onMessage?.(text); }
  function recordSide() {
    if (!available || !freshQuery(current.current.scene, current.current.tracking, Date.now() / 1000)) {
      notify("A fresh localized camera query and an explicitly selected doorway and floor are required."); return;
    }
    const side = {
      ref: { map_id: scene.id, revision: scene.revision, query_id: tracking.queryId,
        element_id: endpoint.element_id, opening_id: endpoint.opening_id, floor_id: floor },
      label: `${scene.name || scene.id}: ${endpoint.label || endpoint.opening_id} (${floor})`,
    };
    if (!first) { setFirst(side); setSecond(null); notify("First doorway side recorded. Identify the other room before recording its side."); }
    else if (first.ref.map_id === side.ref.map_id) notify("The second doorway side must be in a different recognized room.");
    else { setSecond(side); setMessage("Confirm only if these are the two sides of the same real doorway."); }
  }
  async function confirm() {
    if (!first || !second || busy || !freshQuery(current.current.scene, current.current.tracking, Date.now() / 1000) ||
        current.current.scene.id !== second.ref.map_id || current.current.scene.revision !== second.ref.revision) {
      notify("The second room needs fresh matching localization before confirmation."); return;
    }
    const run = generation.current;
    setBusy(true);
    try {
      const evidence = await request(`/maps/${first.ref.map_id}/connection-endpoints`);
      if (generation.current !== run || !alive.current) return;
      if (evidence.revision !== first.ref.revision || evidence.map_id !== first.ref.map_id ||
          !evidence.endpoints?.some(value => value.element_id === first.ref.element_id &&
            value.opening_id === first.ref.opening_id && value.floor_ids.includes(first.ref.floor_id))) {
        setFirst(null); setSecond(null);
        throw new Error("The first doorway model changed. Record both sides again.");
      }
      if (!freshQuery(current.current.scene, current.current.tracking, Date.now() / 1000) ||
          current.current.scene.id !== second.ref.map_id || current.current.scene.revision !== second.ref.revision)
        throw new Error("Second-room localization expired. Reacquire it before confirming.");
      await request("/room-connections", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: first.ref, b: second.ref, user_confirmed: true,
          evidence: "explicit user-observed doorway link" }) });
      if (generation.current !== run || !alive.current) return;
      setFirst(null); setSecond(null);
      notify("Doorway association saved from your confirmation and retained camera evidence. Physical crossing and clearance remain unverified.");
    } catch (error) {
      if (generation.current !== run || !alive.current) return;
      if ([404, 409].includes(error.status)) { setFirst(null); setSecond(null); }
      notify(error.message);
    } finally { if (generation.current === run && alive.current) setBusy(false); }
  }

  return <details>
    <summary>Confirm a connection between rooms</summary>
    <p>Select each authored doorway side only where a fresh localized camera observation is available. Confirming records your observed association, not safe passage.</p>
    <label>Doorway in {scene?.name || "the recognized room"}
      <select value={opening} disabled={busy || !model?.endpoints.length} onChange={event => { setOpening(event.target.value); setFloor(""); setSecond(null); }}>
        <option value="">Select an authored doorway</option>
        {model?.endpoints.map(value => <option key={endpointKey(value)} value={endpointKey(value)}>{value.label || value.opening_id} ({value.kind})</option>)}
      </select>
    </label>
    <label>Modeled floor
      <select value={floor} disabled={busy || !floors.length} onChange={event => { setFloor(event.target.value); setSecond(null); }}>
        <option value="">Select the floor</option>
        {floors.map(id => <option key={id} value={id}>{scene?.architecture?.elements.find(value => value.id === id)?.label || id}</option>)}
      </select>
    </label>
    <p>{fresh ? "Fresh localized query available." : "No fresh localized camera query. Doorway recording is unavailable."}</p>
    <button type="button" disabled={busy || !available || (first && first.ref.map_id === scene?.id)} onClick={recordSide}>
      {first ? "Record second doorway side" : "Record first doorway side"}
    </button>
    {first && <p>First side: {first.label}</p>}
    {second && <>
      <p>Second side: {second.label}</p>
      <button type="button" disabled={busy || !fresh} onClick={confirm}>Confirm {first.label} connects to {second.label}</button>
    </>}
    {first && <button type="button" disabled={busy} onClick={() => { setFirst(null); setSecond(null); notify("Doorway confirmation cancelled. No connection saved."); }}>Cancel doorway confirmation</button>}
    <p role="status" aria-live="polite">{message}</p>
  </details>;
}

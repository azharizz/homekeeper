import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { request } from "./spaces/api";
import { createGuideTracker } from "./guide-tracking.js";
import { completeGuideSpeech, replaySourceTime } from "./guide-replay-state.js";
import { simulationFrame, SIMULATION_CUES } from "./guide-simulation.js";
import GuideConnections from "./GuideConnections.jsx";
const GuideDebug = lazy(() => import("./GuideDebug.jsx"));
import "./guide.css";

export default function HomeGuide() {
  const replay = new URLSearchParams(location.search).get("replay") === "aria";
  const [caption, setCaption] = useState(replay ? "Loading demo…" : "Tap Talk. Ask naturally."), [phase, setPhase] = useState("idle"), [cameraOn, setCameraOn] = useState(false);
  const video = useRef(null), stream = useRef(null), recognition = useRef(null), pending = useRef(null), epoch = useRef(0), session = useRef(null), room = useRef(null), serverRoom = useRef(null);
  const alive = useRef(true), handsFree = useRef(false), timer = useRef(null), last = useRef(replay ? "Demo. Tap Camera to start, or Talk about the current frame." : "Ask where something is, or which saved room to align. Tracking is experimental.");
  const query = new URLSearchParams(location.search), debug = query.get("debug") === "1";
  const [replayMeta, setReplayMeta] = useState(null), [replayError, setReplayError] = useState("");
  const replayRun = useRef(null), replayMidpoint = useRef(false), replayCanvas = useRef(null), utterance = useRef(null);
  const [simulationTime, setSimulationTime] = useState(0);
  const [selectedRoom, setSelectedRoom] = useState(null), [scene, setScene] = useState(null), [target, setTarget] = useState(null);
  const simulation = replay ? simulationFrame(scene, simulationTime) : null;
  const [tracking, setTracking] = useState({ status: "stopped", position: null, quaternion: null }), [route, setRoute] = useState(null);
  const [debugRooms, setDebugRooms] = useState([]), [trackingError, setTrackingError] = useState("");
  const tracker = useRef(null), trackingRef = useRef(tracking), routeRef = useRef(null), routeEpoch = useRef(0);
  const cameraActive = useRef(false), mediaPending = useRef(null), mediaEpoch = useRef(0), xrStarting = useRef(false);
  const selectionEpoch = useRef(0);
  const guidanceSpeech = useRef({ key: null, at: 0, voice: null });
  const [locationResolution, setLocationResolution] = useState(null);
  const [destination, setDestination] = useState(null);
  const [obstacleConsent, setObstacleConsent] = useState(false), [obstacleStatus, setObstacleStatus] = useState("unknown");
  const obstaclePause = useRef(false);
  useEffect(() => {
    if (replay || !cameraOn || !obstacleConsent) return;
    const abort = new AbortController();
    let timeout;
    async function observe() {
      try {
        if (pending.current || document.hidden) return;
        const result = await json("/api/guide-obstacles", { consent: true, image: snapshot() },
          AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]));
        if (abort.signal.aborted || !alive.current) return;
        setObstacleStatus(result.status === "blocked" ? "Visible obstacle reported; clearance unknown" : "unknown");
        if (result.status === "blocked" && !obstaclePause.current) {
          obstaclePause.current = true; routeRef.current = null; setRoute(null);
          clearGuidanceSpeech();
          if (!pending.current) { interrupt(); say(result.caution); }
        }
      } catch {
        if (!abort.signal.aborted) setObstacleStatus("unknown");
      } finally {
        if (!abort.signal.aborted) timeout = setTimeout(observe, 4000);
      }
    }
    void observe();
    return () => { abort.abort(); clearTimeout(timeout); };
  }, [cameraOn, obstacleConsent]);
  const discoveryPending = useRef(false);
  useEffect(() => {
    if (replay || !cameraOn) return;
    const abort = new AbortController();
    let timeout;
    async function discover() {
      try {
        if (pending.current || discoveryPending.current || trackingRef.current.status === "tracking" || document.hidden) return;
        discoveryPending.current = true;
        const selection = selectionEpoch.current;
        const image = snapshot();
        if (!session.current) {
          const created = await json("/api/conversations", {}, abort.signal);
          if (abort.signal.aborted) return;
          session.current = created.id;
        }
        const result = await json(`/api/conversations/${session.current}/recognize`, { image },
          AbortSignal.any([abort.signal, AbortSignal.timeout(18000)]));
        if (abort.signal.aborted || !alive.current || selection !== selectionEpoch.current || pending.current) return;
        if (result.status === "recognized" && result.guideSpace) {
          serverRoom.current = result.guideSpace; room.current = result.guideSpace;
          setSelectedRoom(current => current?.id === result.guideSpace.id && current?.revision === result.guideSpace.revision ? current : result.guideSpace);
          setTarget(result.guideTarget || null);
          setDestination(result.guideDestination || null);
          setTrackingError("");
          if (!utterance.current) { interrupt(); say(`Camera matched ${result.guideSpace.name}. Model alignment remains an estimate.`); }
        } else {
          setTrackingError(result.reason || "Room unknown. Show another view of the saved room.");
          if (!utterance.current) setCaption(result.reason || "I cannot identify this room. Show another view.");
        }
      } catch (error) {
        if (!abort.signal.aborted && alive.current) setTrackingError(error.message);
      } finally {
        discoveryPending.current = false;
        if (!abort.signal.aborted) timeout = setTimeout(discover, 4000);
      }
    }
    void discover();
    return () => { abort.abort(); clearTimeout(timeout); };
  }, [cameraOn]);
  useEffect(() => {
    if (replay) return;
    tracker.current = createGuideTracker({ video: video.current, request, onUpdate(value) {
      if (!alive.current) return;
      trackingRef.current = value; setTracking(value);
      if (value.status !== "tracking") { routeRef.current = null; setRoute(null); clearGuidanceSpeech(); }
      if (value.source === "camera" && cameraActive.current && !stream.current && !xrStarting.current)
        void acquireCamera().catch(error => setTrackingError(error.message));
    } });
    return () => tracker.current?.stop();
  }, []);
  useEffect(() => {
    if (debug) request("/maps").then(maps => setDebugRooms(maps.filter(m => m.status === "ready" && m.options?.engine === "architecture"))).catch(e => setTrackingError(e.message));
  }, [debug]);
  useEffect(() => {
    const selection = ++selectionEpoch.current, abort = new AbortController();
    async function selectReference() {
      let id = query.get("space");
      if (replay) {
        try {
          const response = await fetch("/api/guide-replay", { signal: abort.signal }), metadata = await response.json();
          if (!response.ok) throw new Error(metadata.error || "The replay clip is unavailable.");
          if (metadata.id !== "aria-dino" || metadata.url !== "/api/guide-replay/aria.mp4" ||
              metadata.start_seconds !== 79 || metadata.end_seconds !== 83 ||
              metadata.duration_seconds !== 16 || metadata.source_seconds_per_second !== 0.25 || !/^[a-f0-9]{32}$/.test(metadata.space_id))
            throw new Error("The replay metadata does not describe the supported slowed 79–83 second clip.");
          if (!alive.current || abort.signal.aborted) return;
          setReplayMeta(metadata); setCaption("Tap Camera to start. Talk asks about the current frame.");
          id = metadata.space_id;
        } catch (error) {
          if (alive.current && !abort.signal.aborted) {
            setReplayError(error.message); setCaption(`Replay unavailable: ${error.message}`);
          }
          return;
        }
      }
      if (!id || selection !== selectionEpoch.current) return;
      if (!/^[a-f0-9]{32}$/.test(id)) { setTrackingError("Invalid reference Space ID."); return; }
      try {
        const value = await request(`/maps/${id}/scene`, { signal: abort.signal });
        if (value.mode !== "architecture") throw new Error("The guide requires a saved structured Space.");
        if (alive.current && selection === selectionEpoch.current && !abort.signal.aborted)
          setSelectedRoom({ id, name: value.name, revision: value.revision });
      } catch (error) {
        if (alive.current && !abort.signal.aborted && selection === selectionEpoch.current) setTrackingError(error.message);
      }
    }
    void selectReference();
    return () => abort.abort();
  }, []);
  useEffect(() => {
    room.current = selectedRoom; setScene(null); setRoute(null); routeRef.current = null;
    if (!selectedRoom) return;
    const abort = new AbortController();
    request(`/maps/${selectedRoom.id}/scene`, { signal: abort.signal }).then(value => {
      if (!alive.current || abort.signal.aborted || room.current?.id !== selectedRoom.id || room.current?.revision !== selectedRoom.revision) return;
      if (value.revision !== selectedRoom.revision) throw new Error("The saved model changed. Select the room again.");
      setScene(value); setTrackingError("");
    }).catch(e => { if (alive.current && !abort.signal.aborted) setTrackingError(e.message); });
    return () => abort.abort();
  }, [selectedRoom?.id, selectedRoom?.revision]);
  useEffect(() => {
    if (!replay) return;
    let frame;
    const update = () => {
      if (video.current) setSimulationTime(video.current.currentTime);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (replay || !cameraOn || !scene || !selectedRoom) return;
    if (scene.guide_readiness?.ready === false) {
      setTrackingError(scene.guide_readiness.reasons.join(" "));
      setCaption("This room needs more calibration evidence before guidance. " + scene.guide_readiness.reasons.join(" "));
      return;
    }
    tracker.current.start(selectedRoom);
    return () => tracker.current.stop();
  }, [cameraOn, scene, selectedRoom?.id, selectedRoom?.revision]);
  useEffect(() => {
    if (replay || !cameraOn) { routeRef.current = null; setRoute(null); return; }
    const id = ++routeEpoch.current, abort = new AbortController();
    let timeout, initialDistance;
    guidanceSpeech.current = { key: null, at: 0, voice: null };
    async function updateRoute() {
      const pose = trackingRef.current;
      try {
        if (obstaclePause.current) { routeRef.current = null; setRoute(null); clearGuidanceSpeech(); return; }
        if (!scene || (!target && !destination) || pose.status !== "tracking" || !pose.position || Date.now() / 1000 - pose.capturedAt > 3 ||
            pose.mapId !== scene.id || pose.revision !== scene.revision) {
          routeRef.current = null; setRoute(null); clearGuidanceSpeech(); return;
        }
        let value, guidance, effectiveTarget = target;
        if (session.current && serverRoom.current?.id === scene.id && serverRoom.current?.revision === scene.revision) {
          const result = await json(`/api/conversations/${session.current}/guidance`, {
            guide_context: { map_id: scene.id, revision: scene.revision, status: "tracking", source: pose.source,
              captured_at: pose.capturedAt, position: pose.position, quaternion: pose.quaternion },
          }, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]));
          value = result.route; guidance = result.guidance;
          effectiveTarget = result.target || target;
          if (!value) { routeRef.current = null; setRoute(null); clearGuidanceSpeech(); return; }
        } else {
          if (!target) { routeRef.current = null; setRoute(null); clearGuidanceSpeech(); return; }
          value = await request(`/maps/${scene.id}/architecture/walkthrough`, { method: "POST",
            headers: { "Content-Type": "application/json" }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
            body: JSON.stringify({ expected_revision: scene.revision, floor_id: target.floorId, target_id: target.elementId, start: [pose.position[0], pose.position[2]] }) });
        }
        if (obstaclePause.current) { routeRef.current = null; setRoute(null); clearGuidanceSpeech(); return; }
        const current = trackingRef.current;
        if (id !== routeEpoch.current || current.status !== "tracking" || current.revision !== scene.revision ||
            Date.now() / 1000 - current.capturedAt > 3) return;
        if (current.mapId !== scene.id || !effectiveTarget || value.target_id !== effectiveTarget.elementId || value.floor_id !== effectiveTarget.floorId || value.revision !== scene.revision) return;
        if (Math.hypot(...current.position.map((v, axis) => v - pose.position[axis])) > 0.2 ||
            Math.abs(current.quaternion.reduce((sum, v, axis) => sum + v * pose.quaternion[axis], 0)) < Math.cos(Math.PI / 24)) {
          routeRef.current = null; setRoute(null); clearGuidanceSpeech(); return;
        }
        initialDistance ??= value.distance_m;
        routeRef.current = { ...value, map_id: scene.id, remaining_m: value.distance_m, progress_m: Math.max(0, initialDistance - value.distance_m),
          computedAt: Date.now() / 1000, sourcePose: pose.position };
        setRoute(routeRef.current); setTrackingError("");
        const now = Date.now();
        const key = guidance && `${guidance.status}:${Math.round((guidance.turn_degrees || 0) / 30)}`;
        if (guidance?.instruction && !pending.current && !utterance.current &&
            (key !== guidanceSpeech.current.key || now - guidanceSpeech.current.at >= 12000)) {
          interrupt();
          say(guidance.instruction);
          guidanceSpeech.current = { key, at: now, voice: utterance.current };
        }
      } catch (error) {
        if (!abort.signal.aborted) { routeRef.current = null; setRoute(null); clearGuidanceSpeech(); setTrackingError(error.message); }
      } finally { if (!abort.signal.aborted) timeout = setTimeout(updateRoute, 1000); }
    }
    void updateRoute();
    return () => { routeEpoch.current++; clearTimeout(timeout); abort.abort(); clearGuidanceSpeech(); };
  }, [cameraOn, scene, target, destination]);
  function clearGuidanceSpeech() {
    const voice = guidanceSpeech.current.voice;
    guidanceSpeech.current = { key: null, at: 0, voice: null };
    if (!voice || utterance.current !== voice) return;
    utterance.current = null; window.speechSynthesis?.cancel();
    if (alive.current) { setPhase("idle"); setCaption("Guidance paused. Wait for a fresh matching position and route."); }
  }
  function interrupt() {
    epoch.current++; clearTimeout(timer.current);
    replayRun.current = null;
    if (replay) video.current?.pause();
    recognition.current?.abort(); recognition.current = null;
    if (replay && pending.current) session.current = null;
    pending.current?.abort(); pending.current = null;
    utterance.current = null;
    window.speechSynthesis?.cancel();
  }
  function closeCamera() {
    cameraActive.current = false; mediaEpoch.current++;
    tracker.current?.stop(); routeRef.current = null;
    if (alive.current) setRoute(null);
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
    if (video.current) video.current.srcObject = null;
    if (alive.current) setCameraOn(false);
  }
  function stop() {
    handsFree.current = false;
    if (pending.current) session.current = null; // An aborted server turn can still be running.
    interrupt(); closeCamera();
    if (alive.current) { setPhase("idle"); setCaption(replay ? "Stopped. Replay, AI request, speech and microphone off." : "Stopped. Camera and microphone off."); }
  }
  useEffect(() => {
    alive.current = true;
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { alive.current = false; stop(); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  function resume(id) {
    if (!alive.current || id !== epoch.current || replayRun.current === id || pending.current) return;
    if (handsFree.current) timer.current = setTimeout(listen, 250);
    else setPhase("idle");
  }
  function say(text, onSpoken) {
    if (!alive.current) return;
    const id = epoch.current;
    last.current = text; setCaption(text); setPhase("speaking");
    utterance.current = null; window.speechSynthesis?.cancel();
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      handsFree.current = false; replayRun.current = null; setPhase("idle");
      if (replay) { video.current?.pause(); setCaption(`${text}\nSpeech output is unavailable. The frame stays paused.`); }
      return;
    }
    const voice = new window.SpeechSynthesisUtterance(text); voice.rate = 0.95; utterance.current = voice;
    voice.onend = () => {
      completeGuideSpeech(id, epoch.current, alive.current, document.hidden, voice, utterance,
        completedId => { if (onSpoken) onSpoken(completedId); else resume(completedId); });
    };
    voice.onerror = () => {
      if (id === epoch.current && utterance.current === voice) {
        utterance.current = null; handsFree.current = false; replayRun.current = null; setPhase("idle");
        if (replay) video.current?.pause();
        setCaption(replay ? `${text}\nSpeech output failed. The frame stays paused; check browser audio support.` : "Speech output failed. Tap Talk to retry.");
      }
    };
    try { window.speechSynthesis.speak(voice); }
    catch {
      utterance.current = null; handsFree.current = false; replayRun.current = null; setPhase("idle");
      if (replay) video.current?.pause();
      setCaption(replay ? `${text}\nSpeech output could not start. The frame stays paused.` : "Speech output failed. Tap Talk to retry.");
    }
  }
  async function json(path, body, signal) {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || "HomeKeeper is unavailable."); return value;
  }
  function snapshot() { return tracker.current.snapshot(); }
  function replaySnapshot() {
    const source = video.current;
    if (!replayMeta || !source?.videoWidth || !source.videoHeight || source.readyState < 2 || source.seeking)
      throw new Error("Replay frame is not ready. Wait for the video to load or finish seeking.");
    const canvas = replayCanvas.current ||= document.createElement("canvas");
    const factor = Math.min(1, 1024 / Math.max(source.videoWidth, source.videoHeight));
    canvas.width = Math.max(1, Math.round(source.videoWidth * factor)); canvas.height = Math.max(1, Math.round(source.videoHeight * factor));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot capture a replay frame.");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const data_url = canvas.toDataURL("image/jpeg", 0.75);
    if (!data_url.startsWith("data:image/jpeg;") || data_url.length > 1400000) throw new Error("The replay JPEG could not be captured. Try another browser.");
    return { image: { data_url, captured_at: Date.now() / 1000 },
      guide_replay: { id: replayMeta.id, time_seconds: replaySourceTime(replayMeta, source.currentTime) } };
  }
  async function continueReplay(id) {
    const source = video.current;
    if (!alive.current || document.hidden || id !== epoch.current || !source || replayError) return;
    replayRun.current = id; setPhase("playing");
    try { await source.play(); }
    catch (error) {
      if (alive.current && id === epoch.current) {
        interrupt(); setPhase("idle");
        setCaption(`Replay could not play: ${error.message || "Unsupported video codec."} The frame stays paused.`);
      }
    }
  }
  function playReplay() {
    handsFree.current = false; interrupt();
    const source = video.current;
    if (!replayMeta || !source || replayError) { say(replayError || "The demo is still loading. Please wait."); return; }
    if (document.hidden) return;
    replayMidpoint.current = false; setCameraOn(true);
    source.playbackRate = 1; source.currentTime = 0;
    setSimulationTime(0);
    say(SIMULATION_CUES[0], id => { void continueReplay(id); });
  }
  function narrateReplay(final = false) {
    const run = replayRun.current, source = video.current;
    if (!alive.current || document.hidden || run == null || run !== epoch.current) return;
    source.pause();
    say(SIMULATION_CUES[final ? 2 : 1], final ? () => {
      replayRun.current = null; setPhase("idle");
    } : id => { void continueReplay(id); });
  }
  function replayProgress() {
    const source = video.current;
    if (replayRun.current !== epoch.current || replayMidpoint.current || source.currentTime < 8) return;
    source.pause(); replayMidpoint.current = true;
    if (source.currentTime !== 8) source.currentTime = 8;
    else narrateReplay();
  }
  function replaySeeked() {
    if (replayMidpoint.current && video.current?.currentTime === 8) narrateReplay();
  }
  function replayEnded() {
    if (video.current?.ended) narrateReplay(true);
  }
  function replayFailed() {
    if (!alive.current) return;
    const code = video.current?.error?.code;
    const message = code === 3 ? "This browser could not decode the replay video. Try a browser with H.264 support." :
      code === 2 ? "The local replay video could not be loaded. Check the connection and clip availability." :
      "The local replay clip is missing or this browser does not support its codec.";
    handsFree.current = false; interrupt(); setReplayError(message); setPhase("idle"); setCaption(`Replay unavailable: ${message}`);
  }
  async function acquireCamera() {
    if (replay) throw new Error("Physical camera access is disabled during prerecorded replay.");
    if (stream.current) return;
    if (mediaPending.current) return mediaPending.current;
    const generation = mediaEpoch.current;
    mediaPending.current = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera requires HTTPS or localhost.");
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (!alive.current || generation !== mediaEpoch.current) { media.getTracks().forEach(t => t.stop()); return; }
      stream.current = media; video.current.srcObject = media;
      await video.current.play();
    })();
    try { await mediaPending.current; } finally { mediaPending.current = null; }
  }
  async function startAR() {
    if (replay) { say("Prerecorded replay has no physical alignment or AR tracking."); return; }
    if (!cameraActive.current || !scene) { say("Open the camera and select a saved room first."); return; }
    xrStarting.current = true;
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
    video.current.srcObject = null;
    try { await tracker.current.startXR(); }
    catch (error) { setTrackingError(error.message); }
    finally {
      xrStarting.current = false;
      if (cameraActive.current && trackingRef.current.source !== "webxr") await acquireCamera().catch(error => setTrackingError(error.message));
    }
  }
  async function ask(text, image, guideReplay, onSpoken) {
    if (replay && (!image || !guideReplay)) throw new Error("Replay questions require a freshly captured prerecorded frame.");
    interrupt(); const id = epoch.current, abort = new AbortController(); pending.current = abort;
    setPhase("thinking"); setCaption("Thinking…");
    const pose = trackingRef.current;
    const fresh = pose.status === "tracking" && pose.mapId === selectedRoom?.id && pose.revision === selectedRoom?.revision &&
      Date.now() / 1000 - pose.capturedAt >= 0 && Date.now() / 1000 - pose.capturedAt <= 3;
    const sameRoom = session.current && selectedRoom && selectedRoom.id === serverRoom.current?.id && selectedRoom.revision === serverRoom.current?.revision;
    const guide_context = !replay && sameRoom ? { map_id: selectedRoom.id, revision: selectedRoom.revision,
      status: fresh ? "tracking" : "lost", source: pose.source || "camera", captured_at: fresh ? pose.capturedAt : Date.now() / 1000,
      position: fresh ? pose.position : null, quaternion: fresh ? pose.quaternion : null } : undefined;
    const reference = replay
      ? `\nThis is a prerecorded Aria demo, not the user's live camera. The saved reference Space is ${selectedRoom?.name || "the demo Space"} (${selectedRoom?.id || replayMeta.space_id}); inspect it with read_guide_room if useful. This does not establish physical location or alignment. The interface labels demo mode. Answer concisely with visible-object cues; retain material uncertainty without repeating generic disclaimers.`
      : selectedRoom && !sameRoom ? `\nThe user selected reference Space ${selectedRoom.name} (${selectedRoom.id}) for alignment; select it with read_guide_room. This does not establish physical location.` : "";
    const message = text + reference;
    try {
      if (!session.current) { const created = await json("/api/conversations", {}, abort.signal); if (id !== epoch.current) return; session.current = created.id; }
      const result = await json(`/api/conversations/${session.current}/turn`, { message, guide: true, read_only: true, ...(guide_context ? { guide_context } : {}), ...(image ? { image } : {}), ...(guideReplay ? { guide_replay: guideReplay } : {}) }, abort.signal);
      if (id !== epoch.current) return;
      if (result.state === "error") throw new Error(result.error || "Please try again.");
      const chosen = result.guideSpace || null;
      serverRoom.current = chosen;
      if (chosen || !replay) {
        room.current = chosen; selectionEpoch.current++;
        setSelectedRoom(current => current?.id === chosen?.id && current?.revision === chosen?.revision ? current : chosen);
      }
      setTarget(result.guideTarget || null);
      setLocationResolution(result.guideLocationResolution || null);
      setDestination(result.guideDestination || null);
      pending.current = null;
      const answer = result.messages.filter(m => m.role === "assistant" && m.content).at(-1)?.content;
      if (replay && !answer) throw new Error("The AI provider returned no answer. Please try again.");
      say(answer || "I couldn't answer that. Please try again.", onSpoken);
    } catch (error) { if (id === epoch.current) { session.current = null; pending.current = null; if (replay) handsFree.current = false; say(replay ? `Replay AI request failed: ${error.message}. The frame stays paused.` : error.message); } }
  }
  async function confirmLocation(candidate) {
    if (!locationResolution || replay) return;
    interrupt();
    const id = epoch.current, abort = new AbortController(); pending.current = abort;
    try {
      const { space_id, element_id, space_revision, space_name, element_label } = candidate;
      await json("/api/ui-actions/resolve_spatial_location", {
        memory_id: locationResolution.memory_id, expected_revision: locationResolution.expected_revision,
        space_id, element_id, space_revision, space_name, element_label,
      }, abort.signal);
      if (id !== epoch.current) return;
      pending.current = null; setLocationResolution(null);
      await ask(`I confirmed the saved location for memory ${locationResolution.memory_id} as ${element_label} in ${space_name}, map ${space_id}, element ${element_id}. Read the updated record and use it as my destination; do not assume I am currently in that room.`);
    } catch (error) { if (id === epoch.current) { pending.current = null; say(error.message); } }
  }
  async function openCamera() {
    if (replay) { camera(); return; }
    interrupt(); const id = epoch.current; setPhase("opening");
    try {
      cameraActive.current = true;
      await acquireCamera();
      if (id !== epoch.current) { closeCamera(); return; }
      setCameraOn(true);
      say("Camera ready. With a selected room, camera views will be matched continuously on your home server. Questions also send a photo to the AI; tracking is experimental and does not detect all obstacles.");
    } catch (error) { if (id === epoch.current) { closeCamera(); say(error.message); } }
  }
  async function matchRoom() {
    if (replay) { say("Prerecorded replay is not physically aligned to the saved Space."); return; }
    if (!room.current) { say("Which saved room would you like to match?"); return; }
    if (!cameraActive.current) { say("Open the camera to match the selected room."); return; }
    await ask("The user requested the current room matching status. Explain the fresh ephemeral tracking context briefly without claiming verified physical position or safe walking.");
  }
  async function handleSpeech(text) {
    const command = text.trim().replace(/[.!?]+$/, "").toLowerCase();
    if (/^(stop|cancel|stop everything|stop demo|stop replay)$/.test(command)) { stop(); return; }
    if (/^(repeat|say that again)$/.test(command)) { say(last.current); return; }
    if (!replay && command === "resume model guidance") {
      obstaclePause.current = false;
      say("Resuming model estimates only. Physical clearance remains unknown.");
      return;
    }
    if (!replay && /^(confirm location|yes confirm location)$/.test(command)) {
      if (locationResolution?.candidates?.length === 1 && locationResolution.status !== "incomplete_evidence") await confirmLocation(locationResolution.candidates[0]);
      else say("Please choose the exact room and container before confirming the location.");
      return;
    }
    if (replay && /^(play|play demo|play the demo|restart|restart demo|restart the demo|replay|replay demo)$/.test(command)) { await playReplay(); return; }
    if (/^(open|start|turn on)( the| my)? camera$/.test(command)) {
      if (cameraActive.current) say("Camera is already on. Ask about the view."); else await openCamera();
      return;
    }
    if (/^(close|stop|turn off)( the| my)? camera$/.test(command)) { closeCamera(); say("Camera off. What would you like to ask?"); return; }
    if (/^match( this| the| my)? (room|view)$/.test(command)) { await matchRoom(); return; }
    try {
      if (replay) { const frame = replaySnapshot(); await ask(text, frame.image, frame.guide_replay); }
      else await ask(text, cameraActive.current ? snapshot() : undefined);
    } catch (error) { say(error.message); }
  }
  function listen() {
    if (!alive.current || !handsFree.current || document.hidden) return;
    interrupt();
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) { handsFree.current = false; say("This browser does not support speech recognition. Use a supported browser."); return; }
    const id = epoch.current, speech = new Speech(); recognition.current = speech;
    let handled = false;
    speech.lang = navigator.language; speech.interimResults = false; speech.continuous = false;
    speech.onresult = event => {
      if (id !== epoch.current || handled) return;
      handled = true; recognition.current = null; speech.abort();
      void handleSpeech(event.results[0][0].transcript);
    };
    speech.onerror = event => {
      if (id !== epoch.current || handled) return;
      if (event.error === "no-speech") return;
      handled = true; handsFree.current = false; recognition.current = null;
      say(`Microphone unavailable: ${event.error}. Tap Talk to retry.`);
    };
    speech.onend = () => { if (id === epoch.current && !handled) { recognition.current = null; resume(id); } };
    try { speech.start(); setPhase("listening"); setCaption("Listening…"); }
    catch { handsFree.current = false; recognition.current = null; say("Microphone could not start. Check browser permission."); }
  }
  function talk() {
    if (replay && phase === "playing") { handsFree.current = true; listen(); return; }
    if (phase !== "idle" || handsFree.current) { stop(); return; }
    handsFree.current = true; listen();
  }
  function camera() {
    if (replay) {
      if (!cameraOn || video.current?.ended) { playReplay(); return; }
      handsFree.current = false; interrupt();
      try {
        const frame = replaySnapshot();
        void ask("What is visible in this prerecorded frame? Describe it briefly without navigation advice.", frame.image, frame.guide_replay);
      } catch (error) { say(error.message); }
      return;
    }
    if (["thinking", "matching", "opening"].includes(phase)) { stop(); return; }
    interrupt();
    if (!cameraActive.current) void openCamera();
    else { try { void ask("What am I looking at? Describe this still photo briefly without navigation advice.", snapshot()); } catch (error) { say(error.message); } }
  }
  return <main className={`voice-guide ${debug ? "voice-guide-debug" : ""}`}>
    <a className="guide-home" href="/" aria-label="Exit Home Guide">HomeKeeper</a>
    {replay && <span className="guide-demo-badge">Simulation</span>}
    {debug && <section className="guide-debug-selection" aria-label="Debug room selection">
      <label>Reference Space <select disabled={replay} aria-label="Debug reference Space" value={selectedRoom?.id || ""} onChange={async event => {
        const id = event.target.value;
        const selection = ++selectionEpoch.current;
        if (replay && pending.current) session.current = null;
        interrupt(); tracker.current?.stop(); setTarget(null); setSelectedRoom(null); setScene(null); room.current = null; setTrackingError("");
        if (!id) return;
        try {
          const value = await request(`/maps/${id}/scene`);
          if (value.mode !== "architecture") throw new Error("The guide requires a saved structured Space.");
          if (alive.current && selection === selectionEpoch.current) setSelectedRoom({ id, name: value.name, revision: value.revision });
        } catch (error) { if (alive.current && selection === selectionEpoch.current) setTrackingError(error.message); }
      }}><option value="">{replay ? "Select saved model reference" : "Select saved Space for alignment"}</option>
        {selectedRoom && !debugRooms.some(m => m.id === selectedRoom.id) && <option value={selectedRoom.id}>{selectedRoom.name}</option>}
        {debugRooms.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      {scene && !replay && <label>Model target <select aria-label="Debug model target" value={target?.elementId || ""} onChange={event => {
        const element = scene.architecture.elements.find(e => e.id === event.target.value);
        const floor = scene.architecture.elements.find(e => e.kind === "slab" && e.level === element?.level);
        setTarget(element && floor ? { elementId: element.id, floorId: floor.id, label: element.label } : null);
      }}><option value="">No target</option>{scene.architecture.elements.filter(e => ["box", "solid", "asset", "rail"].includes(e.kind)).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>}
      {scene && !scene.localizable && !replay && <div className="guide-calibration-help">
        <p>Alignment unavailable: this revision has no localization index. It needs at least eight non-coplanar landmarks observed in two calibrated photos.</p>
        <a href={`/?view=spaces#space=${scene.id}`}>Open Space photo evidence and calibration</a>
        <button onClick={async () => {
          try {
            await request(`/maps/${scene.id}/architecture/landmarks`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expected_revision: scene.revision }) });
            const current = await request(`/maps/${scene.id}/scene`);
            if (current.id === room.current?.id && current.revision === room.current?.revision) { setScene(current); setTrackingError(""); }
          } catch (error) { setTrackingError(error.message); }
        }}>Build index from saved calibration</button>
      </div>}
      {trackingError && <p role="alert">{trackingError}</p>}
    </section>}
    <div className={debug ? "guide-debug-layout" : "guide-camera-preview"}>
      <video ref={video} muted playsInline hidden={!cameraOn || (!replay && tracking.source === "webxr")}
        src={replay ? replayMeta?.url : undefined} preload={replay ? "auto" : undefined}
        aria-label={replay ? "Prerecorded demo preview, not a live camera" : "Camera preview"}
        onLoadedData={replay ? () => { if (alive.current) setReplayError(""); } : undefined}
        onPlay={replay ? () => { if (replayRun.current !== epoch.current || document.hidden) video.current?.pause(); } : undefined}
        onTimeUpdate={replay ? replayProgress : undefined} onSeeked={replay ? replaySeeked : undefined}
        onEnded={replay ? replayEnded : undefined} onError={replay ? replayFailed : undefined} />
    {debug && <Suspense fallback={<p>Loading tracking debug view…</p>}><GuideDebug scene={scene} tracking={tracking} target={target} route={route} simulation={simulation} simulated={replay}
      onStartXR={replay ? undefined : startAR}
      onStopTracking={replay ? undefined : () => tracker.current?.stop()} /></Suspense>}
    </div>
    <div className={`voice-orb ${phase}`} aria-hidden="true" />
    <p className="voice-caption" role="status" aria-live="polite" aria-atomic="true" tabIndex={0}>{caption}</p>
    <div className="voice-actions">
      <button onClick={talk} aria-label={phase === "idle" || (replay && phase === "playing") ? "Talk" : "Stop everything"}><span aria-hidden="true">{phase === "idle" || (replay && phase === "playing") ? "●" : "■"}</span>{phase === "idle" || (replay && phase === "playing") ? "Talk" : "Stop"}</button>
      <button onClick={camera} disabled={replay && (!replayMeta || !!replayError)} aria-label={cameraOn ? "Camera: describe this view" : "Camera"}><span aria-hidden="true">◎</span>Camera</button>
    </div>
    {!replay && locationResolution?.candidates?.length > 0 && <section aria-label="Confirm saved item location">
      <p>Confirm where you actually stored {locationResolution.title}. This does not detect the item.</p>
      {locationResolution.candidates.map(candidate => <button key={`${candidate.space_id}:${candidate.element_id}`}
        disabled={!!pending.current} onClick={() => confirmLocation(candidate)}>
        Confirm {candidate.element_label} in {candidate.space_name}
      </button>)}
    </section>}
    {!replay && <p className="guide-demo-link"><a href="/?view=guide&replay=aria">Try the prerecorded voice demo · no camera</a></p>}
    <p className="voice-footnote">{replay ? "Scripted simulation · not measured tracking" : <>{cameraOn ? `Tracking: ${tracking.status} · ${tracking.source || "camera"} · ` : ""}Experimental model alignment · Not a verified walking aid</>}</p>
    {!replay && obstacleConsent && <p role="status">Visible-obstacle observation: {obstacleStatus}. A camera image cannot confirm a clear path.</p>}
    <details className="voice-privacy"><summary>Privacy & help</summary>
      {!replay && cameraOn && <GuideConnections request={request} scene={scene} tracking={tracking} onMessage={say} />}
      {!replay && <label><input type="checkbox" checked={obstacleConsent} onChange={event => setObstacleConsent(event.target.checked)} />
        Send camera stills to the configured AI provider every few seconds to flag visible obstacles. This cannot detect every hazard or confirm clearance.</label>}
      {replay ? <>
        <p>Camera starts the scripted simulation. Spoken step cues and the authored virtual camera share the video's timeline. Playback pauses for each cue and resumes after speech finishes. These steps and positions are demonstration values, not measured directions. Talk pauses playback for optional AI questions about the visible frame.</p>
        <p>The demo is prerecorded Aria footage from source seconds 79–83, encoded at quarter speed and played at normal speed. Frame JPEGs are resized to at most 1024 pixels without overlays or cropping; they carry the source-video time plus the current capture wall time. Still images go to the configured AI provider; image bytes are not saved in chat history. Saved Space geometry is reference-only, not physical alignment or safe navigation. Talk uses your browser's microphone and speech service. Stop, backgrounding, or leaving cancels playback, requests, speech and microphone. Physical camera, localization and AR stay off. Speech or provider failures leave the frame paused.</p>
        {replayError && <p role="alert">{replayError}</p>}
        {trackingError && !debug && <p role="alert">Reference Space unavailable: {trackingError}</p>}
        <p>{selectedRoom ? `Saved reference Space: ${selectedRoom.name} · revision ${selectedRoom.revision}` : trackingError ? "Reference Space unavailable" : "Loading saved reference Space…"} · model reference only</p>
        <p>{replayMeta?.credit || "Aria Digital Twin Dataset, Meta Reality Labs Research"} · <a href="https://www.projectaria.com/datasets/adt/license/" target="_blank" rel="noreferrer">Dataset license</a> · local private research demo</p>
      </>
        : <><p>Tap Talk once; listening resumes after replies. Say “open camera”, “close camera”, “repeat”, or “stop”. Selecting a room and opening Camera starts repeated image matching on your home server, retaining up to 64 recent observations. Questions send a separate still photo to the AI provider; image bytes are not saved in chat history. Experimental pose and model-route estimates are not live obstacle detection. Backgrounding or leaving stops sensors. HTTPS and device permissions are required.</p><button onClick={startAR}>Enable AR tracking</button></>}
      <a href={`/?view=guide${debug ? "" : "&debug=1"}${replay ? "&replay=aria" : ""}${selectedRoom ? `&space=${encodeURIComponent(selectedRoom.id)}` : ""}`}>{debug ? "Open simple guide" : `Open ${replay ? "model reference" : "tracking"} debug view`}</a>
    </details>
  </main>;
}

export function replaySourceTime(metadata, playbackSeconds) {
  return Math.min(metadata.end_seconds, Math.max(metadata.start_seconds,
    metadata.start_seconds + playbackSeconds * metadata.source_seconds_per_second));
}

export function completeGuideSpeech(id, currentId, active, hidden, voice, utterance, complete) {
  if (!active || hidden || id !== currentId || utterance.current !== voice) return false;
  utterance.current = null;
  complete(id);
  return true;
}

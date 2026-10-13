// A geometric match is never a physical-navigation authorization.
export function matchMessage(result, loadedRevision, currentRevision, now) {
  if (result.status !== "localized" || result.map_revision !== loadedRevision || currentRevision !== loadedRevision ||
      !Number.isFinite(result.captured_at) || now - result.captured_at > 10 || result.captured_at > now ||
      !Array.isArray(result.display_position) || result.display_position.length !== 3 || !result.display_position.every(Number.isFinite)) {
    return "Position unknown. The view did not produce a fresh match to this room revision. Stay stationary and ask your companion to check the room and landmarks.";
  }
  return "Camera view matched the saved room. This is an unverified model estimate, not a measured physical position. It does not check obstacles or authorize walking. Stay stationary.";
}

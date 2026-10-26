/** Human verdicts override the model threshold without changing its original score. */
export function includedDetection(detection, threshold) {
  if (detection.review === "rejected") return false;
  return detection.review === "confirmed" || detection.confidence >= threshold;
}

/** Give a call two seconds of context; the player clamps to available audio. */
export const detectionPlaybackStart = (time) => time - 2000;

/** The Gantt can include candidates, but a human rejection is always excluded. */
export function shownInGantt(detection, confidentOnly, threshold = 0.6) {
  return detection.review !== "rejected" && (!confidentOnly || includedDetection(detection, threshold));
}

/**
 * A species' confidence threshold: its learned one from thresholds.json's `species` map (keyed by
 * scientific name), null when it's blocked (only confirmed detections count), or `fallback` for a
 * species without enough reviews. The rule matches threshold() in pipeline/thresholds.py.
 */
export function speciesThreshold(scientific, fallback, thresholds = null) {
  const entry = thresholds?.[scientific ?? ""];
  if (!entry) return fallback;
  return entry.blocked ? null : entry.threshold ?? fallback;
}

/**
 * Human verdicts override the model threshold without changing its original score. The detection's
 * species (`scientific`, or Live's `scientific_name`) picks its learned threshold, if it has one.
 */
export function includedDetection(detection, threshold, thresholds = null) {
  if (detection.review === "rejected") return false;
  if (detection.review === "confirmed") return true;
  const t = speciesThreshold(detection.scientific ?? detection.scientific_name, threshold, thresholds);
  return t !== null && detection.confidence >= t;
}

/** Give a call two seconds of context; the player clamps to available audio. */
export const detectionPlaybackStart = (time) => time - 2000;

/** The Gantt can include candidates, but a human rejection is always excluded. */
export function shownInGantt(detection, confidentOnly, threshold = 0.6, thresholds = null) {
  return detection.review !== "rejected" && (!confidentOnly || includedDetection(detection, threshold, thresholds));
}

/**
 * A species' threshold from thresholds.json's `species` (by scientific name): learned, null when
 * blocked (only confirmed count), or `fallback`. Matches threshold() in pipeline/thresholds.py.
 */
export function speciesThreshold(scientific, fallback, thresholds = null) {
  const entry = thresholds?.[scientific ?? ""];
  if (!entry) return fallback;
  return entry.blocked ? null : entry.threshold ?? fallback;
}

/** Human verdicts override the threshold; `scientific` (or Live's `scientific_name`) picks it. */
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

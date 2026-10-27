/** Temporal cues use actual 3-second detections, not the gaps joined into a label run. */
export const DETECTION_MS = 3000;

export function detectionStarts(detections = [], reviewOf = () => null) {
  return detections.filter((d) => !d.unidentified && reviewOf(d) !== "rejected")
    .map((d) => Date.parse(d.at)).filter(Number.isFinite).sort((a, b) => a - b);
}

export function speciesActivity(strips, reviewOf = () => null) {
  const grouped = new Map();
  for (const strip of strips) for (const detection of strip.detections) {
    const name = detection.common_name;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(detection);
  }
  return new Map([...grouped].map(([name, detections]) => [name, detectionStarts(detections, reviewOf)]));
}

/** Binary search works for forward playback and arbitrary backward seeks. */
export function detectingAt(starts, playhead) {
  if (!Number.isFinite(playhead)) return false;
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= playhead) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && playhead < starts[lo - 1] + DETECTION_MS;
}

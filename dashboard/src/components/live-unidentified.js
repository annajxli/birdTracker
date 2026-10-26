export const UNIDENTIFIED = 'Unidentified bird';
export function unidentifiedDetections(strips) {
  return strips.flatMap(strip => (strip.unidentified ?? []).filter(d => Number.isFinite(Date.parse(d.at))).map(d => ({
    at: d.at, seconds: d.seconds ?? 3, common_name: UNIDENTIFIED,
    confidence: 0, unidentified: true
  })));
}
export function unidentifiedRuns(strips) {
  const result = [];
  for (const d of unidentifiedDetections(strips).sort((a,b) => Date.parse(a.at)-Date.parse(b.at))) {
    const start = Date.parse(d.at), end = start + d.seconds * 1000;
    const last = result.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else result.push({name: UNIDENTIFIED, start, end, best: 0, unidentified: true});
  }
  return result;
}

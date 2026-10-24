// Find each species' strongest change between consecutive complete calendar
// months. Inputs are already deduplicated to minutes heard.
export function biggestMonthlyChanges(minutes, recordedDates, {limit = 8, minRecordedDays = 15} = {}) {
  const dates = [...new Set(recordedDates)].sort();
  if (!dates.length) return [];
  const dayMs = 86400000;
  const first = Date.parse(dates[0]);
  const length = Math.round((Date.parse(dates.at(-1)) - first) / dayMs) + 1;
  const index = (date) => Math.round((Date.parse(date) - first) / dayMs);
  const dateAt = (i) => new Date(first + i * dayMs).toISOString().slice(0, 10);
  const months = [];
  const cursor = new Date(first);
  cursor.setUTCDate(1);
  while (+cursor < first + length * dayMs) {
    const start = Math.round((+cursor - first) / dayMs);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const end = Math.round((+cursor - first) / dayMs);
    if (start >= 0 && end <= length) months.push({start, end});
  }
  if (months.length < 2) return [];
  const recorded = new Uint32Array(length + 1);
  for (const date of dates) recorded[index(date) + 1] = 1;
  for (let i = 1; i <= length; ++i) recorded[i] += recorded[i - 1];
  const counts = new Map();
  for (const row of minutes) {
    const i = index(row.date);
    if (i < 0 || i >= length) continue;
    if (!counts.has(row.species)) counts.set(row.species, new Uint32Array(length + 1));
    counts.get(row.species)[i + 1]++;
  }
  const changes = [];
  for (const [species, prefix] of counts) {
    for (let i = 1; i <= length; ++i) prefix[i] += prefix[i - 1];
    let best;
    for (let i = 1; i < months.length; ++i) {
      const previous = months[i - 1];
      const current = months[i];
      const daysBefore = recorded[previous.end] - recorded[previous.start];
      const daysNow = recorded[current.end] - recorded[current.start];
      // Avoid presenting a few isolated recording days as a month-long trend.
      if (daysBefore < minRecordedDays || daysNow < minRecordedDays) continue;
      const before = (prefix[previous.end] - prefix[previous.start]) / daysBefore;
      const now = (prefix[current.end] - prefix[current.start]) / daysNow;
      const delta = now - before;
      if (Math.abs(delta) < 1e-9) continue;
      if (!best || Math.abs(delta) >= Math.abs(best.delta)) {
        best = {species, before, now, delta, daysBefore, daysNow,
          prevFrom: dateAt(previous.start), prevTo: dateAt(previous.end - 1),
          nowFrom: dateAt(current.start), nowTo: dateAt(current.end - 1)};
      }
    }
    if (best) changes.push(best);
  }
  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.species.localeCompare(b.species)).slice(0, limit);
}

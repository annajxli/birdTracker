// Changes in how much each species is heard, between two sets of recorded days. A change only
// counts if it is unlikely under chance: minutes come in bouts, so day-to-day counts swing a
// lot, and the day (not the minute) is the independent unit. Each species gets a permutation
// test on its per-day minutes (shuffle which window each recorded day belongs to), and the
// p-values are adjusted for testing every species at once (Benjamini-Hochberg).

const DAY_MS = 86400000;
const FLOOR = 0.25; // minutes per day added to both sides of a ratio, so 0 -> 0.3 isn't infinite

// Size of a change: how many times more (or less) the species was heard.
export const effect = (d) => Math.log((d.now + FLOOR) / (d.before + FLOOR));

// Small seeded generator, so the same data always gives the same answer.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// For n days of which the first k are "now": `permutations` random choices of k days to call
// "now", shared by every species tested on the same days.
function shuffles(n, k, permutations, seed) {
  const rand = random(seed);
  const picks = new Uint16Array(permutations * k);
  const order = Uint16Array.from({length: n}, (_, i) => i);
  for (let p = 0; p < permutations; ++p) {
    for (let i = 0; i < k; ++i) {
      const j = i + Math.floor(rand() * (n - i));
      [order[i], order[j]] = [order[j], order[i]];
      picks[p * k + i] = order[i];
    }
  }
  return picks;
}

// Two-sided p-value for the difference in mean per-day minutes: counts[0..k) are "now",
// counts[k..n) "before".
function pValue(counts, k, picks, permutations) {
  const n = counts.length;
  let total = 0;
  for (const c of counts) total += c;
  let sumNow = 0;
  for (let i = 0; i < k; ++i) sumNow += counts[i];
  const diff = (s) => s / k - (total - s) / (n - k);
  const observed = Math.abs(diff(sumNow)) - 1e-9;
  let extreme = 0;
  for (let p = 0, o = 0; p < permutations; ++p) {
    let s = 0;
    for (let i = 0; i < k; ++i) s += counts[picks[o++]];
    if (Math.abs(diff(s)) >= observed) ++extreme;
  }
  return (extreme + 1) / (permutations + 1);
}

// Benjamini-Hochberg: sets each item's q (false discovery rate at which it would be kept).
function adjust(items) {
  const sorted = [...items].sort((a, b) => a.p - b.p);
  let q = 1;
  for (let i = sorted.length - 1; i >= 0; --i) sorted[i].q = q = Math.min(q, (sorted[i].p * sorted.length) / (i + 1));
  return items;
}

// Per-day minute counts for each species on the given days (in order).
function dailyCounts(minutes, days) {
  const index = new Map(days.map((d, i) => [d, i]));
  const counts = new Map();
  for (const {date, species} of minutes) {
    const i = index.get(date);
    if (i === undefined) continue;
    if (!counts.has(species)) counts.set(species, new Uint32Array(days.length));
    counts.get(species)[i]++;
  }
  return counts;
}

const mean = (counts, from, to) => {
  let s = 0;
  for (let i = from; i < to; ++i) s += counts[i];
  return s / (to - from);
};

// Every species heard in either window, with its per-day means and p-value (q not yet set).
function testWindows(counts, k, n, {permutations, seed}) {
  const picks = shuffles(n, k, permutations, seed);
  return [...counts].map(([species, c]) => {
    const now = mean(c, 0, k);
    const before = mean(c, k, n);
    return {species, before, now, delta: now - before, p: pValue(c, k, picks, permutations)};
  });
}

// Species whose minutes heard per day changed between two windows of recorded days, beyond what
// chance would give. Returns increases (largest first) then decreases (largest last), up to
// `limit` of each, ranked by the size of the change relative to how common the species is.
export function windowChanges(minutes, nowDays, beforeDays, {limit = 8, alpha = 0.05, permutations = 2000, seed = 1} = {}) {
  const days = [...nowDays, ...beforeDays];
  if (!nowDays.length || !beforeDays.length) return [];
  const tested = adjust(testWindows(dailyCounts(minutes, days), nowDays.length, days.length, {permutations, seed}));
  const kept = tested.filter((d) => d.q <= alpha && d.delta !== 0);
  const up = kept.filter((d) => d.delta > 0).sort((a, b) => effect(b) - effect(a)).slice(0, limit);
  const down = kept.filter((d) => d.delta < 0).sort((a, b) => effect(a) - effect(b)).slice(0, limit).reverse();
  return [...up, ...down];
}

// Find each species' strongest clear change between consecutive complete calendar months.
// Inputs are already deduplicated to minutes heard.
export function biggestMonthlyChanges(minutes, recordedDates, {limit = 8, minRecordedDays = 15, alpha = 0.05, permutations = 2000, seed = 1} = {}) {
  const dates = [...new Set(recordedDates)].sort();
  if (!dates.length) return [];
  const first = Date.parse(dates[0]);
  const last = Date.parse(dates.at(-1));
  const dateAt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const months = [];
  const cursor = new Date(first);
  cursor.setUTCDate(1);
  while (+cursor <= last) {
    const start = +cursor;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const end = +cursor - DAY_MS; // last day of the month
    // Only complete months, with enough recording days to stand for the month.
    const days = dates.filter((d) => d >= dateAt(start) && d <= dateAt(end));
    if (start >= first && end <= last && days.length >= minRecordedDays) months.push({start, end, days});
  }
  const tested = [];
  for (let i = 1; i < months.length; ++i) {
    const previous = months[i - 1];
    const current = months[i];
    if (Math.round((current.start - previous.end) / DAY_MS) !== 1) continue; // consecutive months only
    const days = [...current.days, ...previous.days];
    for (const d of testWindows(dailyCounts(minutes, days), current.days.length, days.length, {permutations, seed: seed + i})) {
      if (d.delta === 0) continue;
      tested.push({...d, daysBefore: previous.days.length, daysNow: current.days.length,
        prevFrom: dateAt(previous.start), prevTo: dateAt(previous.end), nowFrom: dateAt(current.start), nowTo: dateAt(current.end)});
    }
  }
  const best = new Map();
  for (const d of adjust(tested)) {
    if (d.q > alpha) continue;
    const b = best.get(d.species);
    if (!b || Math.abs(effect(d)) >= Math.abs(effect(b))) best.set(d.species, d);
  }
  return [...best.values()]
    .sort((a, b) => Math.abs(effect(b)) - Math.abs(effect(a)) || a.species.localeCompare(b.species))
    .slice(0, limit);
}

import test from "node:test";
import assert from "node:assert/strict";
import {biggestMonthlyChanges, dayChanges, windowChanges} from "../src/components/changes.js";

const days = (from, through) => Array.from(
  {length: Math.round((Date.parse(through) - Date.parse(from)) / 86400000) + 1},
  (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
const minutes = (dates, count, species = "Robin") => dates.flatMap((date) =>
  Array.from({length: count(date)}, () => ({date, species})));

test("compares complete months, including a 28-day February", () => {
  const dates = days("2026-01-01", "2026-02-28");
  const [change] = biggestMonthlyChanges(minutes(dates, (d) => d < "2026-02-01" ? 2 : 8), dates);
  assert.deepEqual([change.before, change.now, change.delta], [2, 8, 6]);
  assert.deepEqual([change.prevFrom, change.prevTo, change.nowFrom, change.nowTo],
    ["2026-01-01", "2026-01-31", "2026-02-01", "2026-02-28"]);
});

test("excludes partial first and last months", () => {
  const dates = days("2026-01-15", "2026-04-15");
  const [change] = biggestMonthlyChanges(minutes(dates, (d) => {
    if (d < "2026-02-01" || d >= "2026-04-01") return 60;
    return d < "2026-03-01" ? 1 : 7;
  }), dates);
  assert.equal(change.delta, 6);
  assert.deepEqual([change.prevFrom, change.nowTo], ["2026-02-01", "2026-03-31"]);
});

test("normalizes for recorder outages and different month lengths", () => {
  const dates = days("2026-01-01", "2026-03-31").filter(d =>
    !d.startsWith("2026-02") || Number(d.slice(-2)) <= 15);
  assert.deepEqual(biggestMonthlyChanges(minutes(dates, () => 4), dates), []);
});

test("keeps decreases, ranks by relative change, and returns one pair per species", () => {
  const dates = days("2026-01-01", "2026-03-31");
  const rows = [...minutes(dates, d => d < "2026-02-01" ? 8 : 2, "Robin"),
    ...minutes(dates, d => d < "2026-02-01" ? 1 : 3, "Wren")];
  const changes = biggestMonthlyChanges(rows, dates);
  assert.deepEqual(changes.map(d => [d.species, d.delta]), [["Robin", -6], ["Wren", 2]]);
  assert.equal(biggestMonthlyChanges(rows, dates, {limit: 1}).length, 1);
});

test("handles leap February and a year boundary", () => {
  const leap = days("2024-01-01", "2024-02-29");
  const [change] = biggestMonthlyChanges(minutes(leap, d => d < "2024-02-01" ? 1 : 2), leap);
  assert.equal(change.nowTo, "2024-02-29");
  assert.equal(change.daysNow, 29);
  const winter = days("2025-12-01", "2026-01-31");
  const [crossYear] = biggestMonthlyChanges(minutes(winter, d => d < "2026-01-01" ? 1 : 2), winter);
  assert.deepEqual([crossYear.prevFrom, crossYear.nowFrom], ["2025-12-01", "2026-01-01"]);
});

test("requires two full months with sufficient recordings", () => {
  assert.deepEqual(biggestMonthlyChanges([], []), []);
  const partial = days("2026-01-02", "2026-02-28");
  assert.deepEqual(biggestMonthlyChanges(minutes(partial, () => 1), partial), []);
  const sparse = days("2026-01-01", "2026-02-28").filter(d =>
    d >= "2026-02-01" || Number(d.slice(-2)) <= 10);
  assert.deepEqual(biggestMonthlyChanges(minutes(sparse, d => d < "2026-02-01" ? 1 : 8), sparse), []);
});

// Bout-like daily minutes: most days a few, some days a long session. Seeded, so tests are stable.
const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const bursty = (rand, mean) => () => (rand() < 0.3 ? Math.round(mean * 2.5 * rand() * 2) : Math.round(mean * 0.35 * rand() * 2));

test("window changes: ordinary day-to-day noise is not a trend", () => {
  const now = days("2026-02-01", "2026-03-02"), before = days("2026-01-02", "2026-01-31");
  const rand = rng(42);
  const rows = ["Robin", "Wren", "Junco", "Towhee", "Flicker"].flatMap((s) => minutes([...now, ...before], bursty(rand, 7), s));
  assert.deepEqual(windowChanges(rows, now, before), []);
});

test("window changes: a real shift is kept, a 7.1 -> 7.0 wobble is not", () => {
  const now = days("2026-02-01", "2026-03-02"), before = days("2026-01-02", "2026-01-31");
  const rand = rng(7);
  const rows = [
    ...minutes(before, bursty(rand, 2), "Robin"), ...minutes(now, bursty(rand, 9), "Robin"),
    ...minutes([...before, ...now], (d) => (d < "2026-02-01" ? 7 : 7) + Math.round(rand() * 6 - 3), "Towhee")];
  const changes = windowChanges(rows, now, before);
  assert.deepEqual(changes.map((d) => d.species), ["Robin"]);
  assert.ok(changes[0].q < 0.05);
});

test("window changes: ranked by relative size, so a rare bird's jump beats a common bird's nudge", () => {
  const now = days("2026-02-01", "2026-03-02"), before = days("2026-01-02", "2026-01-31");
  const rows = [
    ...minutes(before, () => 20, "Crow"), ...minutes(now, () => 23, "Crow"),
    ...minutes(before, () => 0, "Kinglet"), ...minutes(now, (d) => Number(d.slice(-2)) % 2 ? 2 : 1, "Kinglet")];
  assert.deepEqual(windowChanges(rows, now, before).map((d) => d.species), ["Kinglet", "Crow"]);
});

test("window changes: same answer every time, and decreases come after increases", () => {
  const now = days("2026-02-01", "2026-03-02"), before = days("2026-01-02", "2026-01-31");
  const rand = rng(3);
  const rows = [...minutes(before, bursty(rand, 8), "Robin"), ...minutes(now, bursty(rand, 1), "Robin"),
    ...minutes(before, bursty(rand, 1), "Wren"), ...minutes(now, bursty(rand, 8), "Wren")];
  const a = windowChanges(rows, now, before), b = windowChanges(rows, now, before);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((d) => [d.species, Math.sign(d.delta)]), [["Wren", 1], ["Robin", -1]]);
});

test("monthly changes: noise between months is not reported", () => {
  const dates = days("2026-01-01", "2026-04-30");
  const rand = rng(11);
  const rows = ["Robin", "Wren", "Junco"].flatMap((s) => minutes(dates, bursty(rand, 6), s));
  assert.deepEqual(biggestMonthlyChanges(rows, dates), []);
});

test("day changes: minutes against the day before, small moves dropped", () => {
  const heard = (date, species, n) => Array.from({length: n}, () => ({date, species}));
  const rows = [
    ...heard("2026-10-28", "House Finch", 12), ...heard("2026-10-27", "House Finch", 5),
    ...heard("2026-10-28", "Crow", 1), ...heard("2026-10-27", "Crow", 6),
    ...heard("2026-10-28", "Robin", 4), ...heard("2026-10-27", "Robin", 3),
    ...heard("2026-10-28", "Jay", 3), ...heard("2026-10-26", "Jay", 20)
  ];
  const changes = dayChanges(rows, "2026-10-28", "2026-10-27");
  assert.deepEqual(changes.map((d) => [d.species, d.before, d.now]), [["House Finch", 5, 12], ["Jay", 0, 3], ["Crow", 6, 1]]);
});

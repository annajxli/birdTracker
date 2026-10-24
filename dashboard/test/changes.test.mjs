import test from "node:test";
import assert from "node:assert/strict";
import {biggestMonthlyChanges} from "../src/components/changes.js";

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

test("keeps decreases, ranks by absolute change, and returns one pair per species", () => {
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

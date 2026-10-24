import test from "node:test";
import assert from "node:assert/strict";
import {periodBounds, shiftPeriod, periodLabel, calendarDays} from "../src/components/period.js";

test("day, Sunday-based week, month, and year use calendar boundaries", () => {
  assert.deepEqual(periodBounds("D", "2026-10-23"), {start: "2026-10-23", end: "2026-10-23"});
  assert.deepEqual(periodBounds("W", "2026-10-23"), {start: "2026-10-18", end: "2026-10-24"});
  assert.deepEqual(periodBounds("M", "2026-10-23"), {start: "2026-10-01", end: "2026-10-31"});
  assert.deepEqual(periodBounds("Y", "2026-10-23"), {start: "2026-01-01", end: "2026-12-31"});
});

test("month navigation does not skip February when anchored on January 31", () => {
  assert.deepEqual(shiftPeriod("M", "2024-01-31", 1), {start: "2024-02-01", end: "2024-02-29"});
  assert.deepEqual(shiftPeriod("M", "2024-03-31", -1), {start: "2024-02-01", end: "2024-02-29"});
});

test("navigation handles year boundaries and DST without changing calendar dates", () => {
  assert.deepEqual(shiftPeriod("Y", "2026-10-23", -1), {start: "2025-01-01", end: "2025-12-31"});
  assert.deepEqual(shiftPeriod("D", "2026-03-08", 1), {start: "2026-03-09", end: "2026-03-09"});
  assert.deepEqual(periodBounds("W", "2026-01-01"), {start: "2025-12-28", end: "2026-01-03"});
});

test("labels distinguish months, years, and weeks crossing a year", () => {
  assert.equal(periodLabel("M", "2026-10-23"), "October 2026");
  assert.equal(periodLabel("Y", "2026-10-23"), "2026");
  assert.equal(periodLabel("W", "2026-10-23"), "Oct 18 – 24, 2026");
  assert.match(periodLabel("W", "2026-01-01"), /2025.*2026/);
});

test("calendar highlights the complete selected week, including adjacent months", () => {
  const cells = calendarDays("2026-01-01", "W", "2026-01-01");
  assert.equal(cells.length, 42);
  const selected = cells.filter((d) => d.selected);
  assert.equal(selected.length, 7);
  assert.equal(selected[0].date, "2025-12-28");
  assert.equal(selected.at(-1).date, "2026-01-03");
});

test("calendar highlights one day, a full month, or the visible part of a year", () => {
  assert.equal(calendarDays("2026-10-01", "D", "2026-10-23").filter(d => d.selected).length, 1);
  assert.equal(calendarDays("2026-10-01", "M", "2026-10-23").filter(d => d.selected).length, 31);
  assert.equal(calendarDays("2026-10-01", "Y", "2026-10-23").filter(d => d.selected).length, 42);
});

test("all time spans everything, has no neighbours, and is labelled as such", () => {
  const bounds = periodBounds("A", "2026-10-22");
  assert.ok(bounds.start < "1000-01-01" && bounds.end > "9000-01-01");
  assert.deepEqual(shiftPeriod("A", "2026-10-22", -1), bounds);
  assert.equal(periodLabel("A", "2026-10-22"), "All time");
});

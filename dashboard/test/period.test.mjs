import test from "node:test";
import assert from "node:assert/strict";
import {periodBounds, shiftPeriod, periodLabel, calendarDays, overviewBounds, TRAILING_DAYS} from "../src/components/period.js";

test("D/W/M/Y end on the selected date with inclusive trailing spans", () => {
  assert.deepEqual(periodBounds("D", "2026-10-26"), {start: "2026-10-26", end: "2026-10-26"});
  assert.deepEqual(periodBounds("W", "2026-10-26"), {start: "2026-10-20", end: "2026-10-26"});
  assert.deepEqual(periodBounds("M", "2026-10-26"), {start: "2026-09-27", end: "2026-10-26"});
  assert.deepEqual(periodBounds("Y", "2026-10-26"), {start: "2025-10-27", end: "2026-10-26"});
});

test("navigation moves by full adjacent spans across month, leap and DST boundaries", () => {
  for (const date of ["2024-01-31", "2024-03-01", "2026-03-09", "2026-01-01"]) {
    for (const [scale, days] of Object.entries(TRAILING_DAYS)) {
      const current = periodBounds(scale, date), previous = shiftPeriod(scale, date, -1);
      const next = shiftPeriod(scale, date, 1);
      assert.equal((Date.parse(current.start) - Date.parse(previous.end)) / 864e5, 1);
      assert.equal((Date.parse(next.start) - Date.parse(current.end)) / 864e5, 1);
      assert.equal((Date.parse(current.end) - Date.parse(current.start)) / 864e5 + 1, days);
      assert.deepEqual(shiftPeriod(scale, previous.end, 1), current);
    }
  }
});

test("labels describe the actual trailing window", () => {
  assert.equal(periodLabel("W", "2026-10-26"), "Oct 20 – 26");
  assert.equal(periodLabel("M", "2026-10-26"), "Sep 27 – Oct 26");
  assert.equal(periodLabel("Y", "2026-10-26"), "Oct 27, 2025 – Oct 26, 2026");
  assert.equal(periodLabel("W", "2026-01-01"), "Dec 26 – Jan 1");
});

test("calendar highlights the complete trailing week even at the start of a month", () => {
  const cells = calendarDays("2026-01-01", "W", "2026-01-01");
  assert.equal(cells.length, 42);
  const selected = cells.filter((d) => d.selected);
  assert.equal(selected.length, 7);
  assert.equal(selected[0].date, "2025-12-26");
  assert.equal(selected.at(-1).date, "2026-01-01");
});

test("calendar highlights the visible part of each trailing span through its end date", () => {
  for (const scale of ["D", "W", "M", "Y"]) {
    const bounds = periodBounds(scale, "2026-10-26");
    const cells = calendarDays("2026-10-01", scale, "2026-10-26");
    assert.ok(cells.find((d) => d.date === "2026-10-26").selected);
    assert.equal(cells.find((d) => d.date === "2026-10-27").selected, false);
    for (const cell of cells) assert.equal(cell.selected, cell.date >= bounds.start && cell.date <= bounds.end);
  }
});

test("all time follows recorded dates, has no neighbours and is labelled as such", () => {
  const bounds = periodBounds("A", "2026-10-26");
  assert.ok(bounds.start < "1000-01-01" && bounds.end > "9000-12-31");
  assert.deepEqual(shiftPeriod("A", "2026-10-26", -1), bounds);
  assert.equal(periodLabel("A", "2026-10-26"), "All time");
  assert.deepEqual(overviewBounds("A", "2026-10-26", "2026-10-25", "2026-10-26"), {start: "2026-10-25", end: "2026-10-26"});
});

test("overview retains all earlier dates in trailing spans with only two days of data", () => {
  for (const scale of ["W", "M", "Y"]) assert.deepEqual(
    overviewBounds(scale, "2026-10-26", "2026-10-25", "2026-10-26"), periodBounds(scale, "2026-10-26"));
});

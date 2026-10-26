import test from "node:test";
import assert from "node:assert/strict";
import {readPeriodSelection, writePeriodSelection} from "../src/components/period-state.js";

const first = "2025-10-24", last = "2026-10-26";

test("refresh restores every span and its selected date", () => {
  for (const scale of ["D", "W", "M", "Y", "A"]) {
    const selection = {scale, date: "2026-08-17"};
    const search = writePeriodSelection("?other=keep", selection);
    assert.deepEqual(readPeriodSelection(search, first, last), selection);
    assert.equal(new URLSearchParams(search).get("other"), "keep");
  }
});

test("a clean URL defaults to latest day; malformed or impossible saved dates are safe", () => {
  for (const search of ["", "?span=bad&date=invalid", "?date=2026-02-30", "?span=constructor"]) {
    assert.deepEqual(readPeriodSelection(search, first, last), {scale: "D", date: last});
  }
});

test("a saved view outside the dataset is clamped without losing its span", () => {
  assert.deepEqual(readPeriodSelection("?span=W&date=2020-01-01", first, last), {scale: "W", date: first});
  assert.deepEqual(readPeriodSelection("?span=M&date=2030-01-01", first, last), {scale: "M", date: last});
});

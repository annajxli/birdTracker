import test from "node:test";
import assert from "node:assert/strict";
import {dailyTemperatureSeries} from "../src/components/weather-series.js";

test("temperature ribbon leaves older and future dates blank", () => {
  const dates = Array.from({length: 7}, (_, i) => `2026-10-${25 + i}`);
  const {days, edges} = dailyTemperatureSeries(dates, {
    "2026-10-25": {low: 40, high: 55}, "2026-10-26": {low: 42, high: 56}
  });
  assert.equal(days.length, 2);
  assert.equal(edges[0].day.toISOString(), "2026-10-24T12:00:00.000Z");
  assert.equal(edges.at(-1).day.toISOString(), "2026-10-26T12:00:00.000Z");
  const older = dailyTemperatureSeries(["2026-10-01", ...dates], {"2026-10-26": {low: 42, high: 56}});
  assert.equal(older.edges[0].day.toISOString(), "2026-10-25T12:00:00.000Z");
});

test("weather gaps split the ribbon instead of implying interpolated data", () => {
  const {edges} = dailyTemperatureSeries(["2026-10-25", "2026-10-26", "2026-10-27"], {
    "2026-10-25": {low: 40, high: 55}, "2026-10-27": {low: 42, high: 56}
  });
  assert.deepEqual([...new Set(edges.map((d) => d.segment))], [0, 1]);
  assert.equal(edges[2].day.toISOString(), "2026-10-25T12:00:00.000Z");
  assert.equal(edges[3].day.toISOString(), "2026-10-26T12:00:00.000Z");
});

test("a sparse caller also leaves missing calendar dates blank", () => {
  const {edges} = dailyTemperatureSeries(["2026-10-25", "2026-10-27"], {
    "2026-10-25": {low: 40, high: 55}, "2026-10-27": {low: 42, high: 56}
  });
  assert.deepEqual([...new Set(edges.map((d) => d.segment))], [0, 1]);
});

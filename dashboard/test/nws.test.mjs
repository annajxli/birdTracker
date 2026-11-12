import test from "node:test";
import assert from "node:assert/strict";
import {fetchJSON, nwsCode, nwsDay, nwsNow} from "../src/components/nws.js";

test("maps NWS short forecasts to weather codes", () => {
  assert.equal(nwsCode("Light Rain Likely"), 63);
  assert.equal(nwsCode("Light Rain"), 63);
  assert.equal(nwsCode("Chance Light Rain"), 3);
  assert.equal(nwsCode("Slight Chance Light Rain"), 3);
  assert.equal(nwsCode("Rain And Snow Likely"), 73);
  assert.equal(nwsCode("Chance Showers And Thunderstorms"), 3);
  assert.equal(nwsCode("Patchy Fog"), 45);
  assert.equal(nwsCode("Mostly Cloudy"), 3);
  assert.equal(nwsCode("Partly Sunny"), 2);
  assert.equal(nwsCode("Mostly Clear"), 0);
});

test("takes a day's hours, worst code, and its share of precipitation", () => {
  const periods = [
    {startTime: "2026-10-30T22:00:00-07:00", temperature: 45, temperatureUnit: "F", shortForecast: "Partly Cloudy"},
    {startTime: "2026-10-30T23:00:00-07:00", temperature: 44, temperatureUnit: "F", shortForecast: "Light Rain Likely"},
    {startTime: "2026-10-31T00:00:00-07:00", temperature: 43, temperatureUnit: "F", shortForecast: "Snow"}
  ];
  // 06:00Z Oct 31 = 11 PM Oct 30 PDT: 1 of the period's 6 hours falls on Oct 30.
  const qpf = {values: [{validTime: "2026-10-31T00:00:00+00:00/PT6H", value: 6}, {validTime: "2026-10-31T06:00:00+00:00/PT6H", value: 25.4 * 6}]};
  const day = nwsDay("2026-10-30", periods, qpf);
  assert.equal(day.code, 63);
  assert.deepEqual([day.hourly[22], day.hourly[23], day.hourly[0]], [45, 44, null]);
  assert.equal(day.precip, Math.round((6 / 25.4 + 1) * 100) / 100);
});

test("is null when the forecast doesn't reach the day", () => {
  assert.equal(nwsDay("2026-11-02", [{startTime: "2026-10-30T22:00:00-07:00", temperature: 45, temperatureUnit: "F", shortForecast: "Sunny"}], null), null);
});

const obs = (timestamp, textDescription, c) => ({properties: {timestamp, textDescription, temperature: {value: c}}});

test("keeps rain observed earlier in the day when the rest is forecast dry", () => {
  const periods = [{startTime: "2026-10-30T14:00:00-07:00", temperature: 50, temperatureUnit: "F", shortForecast: "Partly Sunny"}];
  const day = nwsDay("2026-10-30", periods, null, [obs("2026-10-30T16:00:00Z", "Light Rain and Fog/Mist", 8), obs("2026-10-29T20:00:00Z", "Snow", 0)]);
  assert.equal(day.code, 63);
});

test("reports the newest described observation", () => {
  const now = nwsNow([obs("2026-10-30T18:45:00Z", "Light Rain", 8), obs("2026-10-30T18:53:00Z", "", 9), obs("2026-10-30T18:50:00Z", "Cloudy", 10)]);
  assert.deepEqual([now.text, now.tempF, +now.time, now.nearTemp], ["Cloudy", 50, Date.parse("2026-10-30T18:50:00Z"), false]);
  assert.equal(nwsNow([]), null);
});

test("takes the nearer station's temperature while it's fresh, else the airport's", () => {
  const sky = [obs("2026-10-30T18:50:00Z", "Cloudy", 10)];
  const near = [obs("2026-10-30T17:30:00Z", "", 5), obs("2026-10-30T18:30:00Z", "", 7), obs("2026-10-30T18:45:00Z", "", null)];
  const fresh = nwsNow(sky, near, Date.parse("2026-10-30T19:00:00Z"));
  assert.deepEqual([fresh.text, +fresh.time, fresh.nearTemp, +fresh.tempTime], ["Cloudy", Date.parse("2026-10-30T18:50:00Z"), true, Date.parse("2026-10-30T18:30:00Z")]);
  assert.ok(Math.abs(fresh.tempF - 44.6) < 1e-9);
  const stale = nwsNow(sky, near, Date.parse("2026-10-30T20:31:00Z"));
  assert.deepEqual([stale.tempF, stale.nearTemp, +stale.tempTime], [50, false, Date.parse("2026-10-30T18:50:00Z")]);
  assert.equal(nwsNow([], near), null); // no conditions, no reading
});

test("rejects a weather request that doesn't answer in time", async () => {
  let aborted = false;
  const stalled = (url, {signal}) => new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }));
  const started = Date.now();
  const hold = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer doesn't keep Node running
  await assert.rejects(fetchJSON("https://example.test/slow", {timeoutMs: 50, fetcher: stalled}), {name: "TimeoutError"});
  clearTimeout(hold);
  assert.ok(aborted && Date.now() - started < 2000);
});

test("rejects an HTTP error and returns JSON otherwise", async () => {
  const answer = (status, body) => async () => ({ok: status < 400, status, json: async () => body});
  await assert.rejects(fetchJSON("u", {fetcher: answer(503)}), (e) => e === 503);
  assert.deepEqual(await fetchJSON("u", {fetcher: answer(200, {a: 1})}), {a: 1});
});

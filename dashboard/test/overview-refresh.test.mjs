import test from "node:test";
import assert from "node:assert/strict";
import {overviewVersions, overviewLimits, startOverviewRefresh, OVERVIEW_REFRESH_MS} from "../src/components/overview-refresh.js";
const settle = () => new Promise(setImmediate);

function harness({hidden = false, load, probe} = {}) {
  const visibility = new EventTarget();
  visibility.visibilityState = hidden ? "hidden" : "visible";
  const focusTarget = new EventTarget();
  const timers = new Map(), published = [], loads = [], errors = [];
  let next = {detections: "one", recordings: "one"}, id = 0, probes = 0;
  const refresh = startOverviewRefresh({initial: {version: 1}, versions: next,
    visibility, focusTarget, setTimer: (fn, delay) => { timers.set(++id, {fn, delay}); return id; },
    clearTimer: (key) => timers.delete(key),
    probe: probe ?? (async () => { probes++; return next; }),
    load: async (args) => { loads.push(args); return load ? load(args) : {version: 2}; },
    publish: (data) => published.push(data), onError: (error) => errors.push(error)
  });
  return {refresh, visibility, focusTarget, timers, published, loads, errors,
    change: (versions) => { next = versions; }, probes: () => probes};
}

test("one-minute metadata probes never download bodies", async () => {
  const calls = [];
  const versions = await overviewVersions(async (url, options) => {
    calls.push({url, options});
    return {ok: !url.endsWith("thresholds.json"), headers: new Headers({ETag: '"abc"'}),
      arrayBuffer() { throw new Error("must not download"); }};
  });
  assert.equal(OVERVIEW_REFRESH_MS, 60_000);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({options}) => options.method === "HEAD" && options.cache === "no-store"));
  assert.deepEqual(versions, {detections: '"abc"', recordings: '"abc"', thresholds: null});
});

test("unchanged versions do not reload or publish; changed versions load once", async () => {
  const h = harness();
  assert.equal([...h.timers.values()][0].delay, 60_000);
  await h.refresh.check();
  assert.equal(h.loads.length, 0);
  assert.equal(h.published.length, 0);
  h.change({detections: "two", recordings: "one"});
  await h.refresh.check();
  assert.deepEqual(h.loads[0], {previous: {version: 1}, changed: ["detections"]});
  assert.deepEqual(h.published, [{version: 2}]);
  await h.refresh.check();
  assert.equal(h.loads.length, 1);
  h.refresh.stop();
});

test("hidden pages stop polling and resume immediately on return", async () => {
  const h = harness({hidden: true});
  assert.equal(h.timers.size, 0);
  await h.refresh.check();
  assert.equal(h.probes(), 0);
  h.change({detections: "two", recordings: "one"});
  h.visibility.visibilityState = "visible";
  h.visibility.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(h.published.length, 1);
  h.visibility.visibilityState = "hidden";
  h.visibility.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.timers.size, 0);
  h.refresh.stop();
});

test("focus checks immediately; failed loads keep the last snapshot and retry", async () => {
  let failed = true;
  const h = harness({load: async () => { if (failed) throw new Error("offline"); return {version: 2}; }});
  h.change({detections: "two", recordings: null});
  h.focusTarget.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(h.published.length, 0);
  assert.equal(h.errors.length, 1);
  failed = false;
  await h.refresh.check();
  assert.deepEqual(h.loads[1].previous, {version: 1});
  assert.equal(h.published.length, 1);
  h.refresh.stop();
});

test("one in-flight request and disposal prevent stale publications", async () => {
  let release;
  const h = harness({probe: () => new Promise((resolve) => { release = resolve; })});
  const pending = h.refresh.check();
  const firstRelease = release;
  await h.refresh.check();
  assert.equal(release, firstRelease);
  h.refresh.stop();
  release({detections: "two"});
  await pending;
  assert.equal(h.loads.length, 0);
  assert.equal(h.published.length, 0);
  assert.equal(h.timers.size, 0);
  h.focusTarget.dispatchEvent(new Event("focus"));
  assert.equal(h.timers.size, 0);
});

test("missing metadata never replaces a good snapshot", async () => {
  const h = harness();
  h.change({detections: null, recordings: null, thresholds: null});
  await h.refresh.check();
  assert.equal(h.loads.length, 0);
  h.refresh.stop();
});

test("calendar limits include real audio but not synthetic telemetry", () => {
  const rows = [{date: "2026-10-26"}];
  const recordings = {numRows: 2, getChild: (key) => ({get: (i) =>
    key === "date" ? ["2026-10-27", "2026-12-31"][i] : [false, true][i]})};
  assert.deepEqual(overviewLimits({all: rows, recordings}, "fallback"), {first: "2026-10-26", last: "2026-10-27"});
  assert.deepEqual(overviewLimits({all: [], recordings: null}, "2026-10-27"), {first: "2026-10-27", last: "2026-10-27"});
});

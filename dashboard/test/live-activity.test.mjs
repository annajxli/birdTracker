import test from "node:test";
import assert from "node:assert/strict";
import {detectionStarts, speciesActivity, detectingAt} from "../src/components/live-activity.js";
const at = (offset, extra = {}) => ({at: new Date(100000 + offset).toISOString(), common_name: "Junco", ...extra});

test("actual detection windows include their start, exclude their end and leave joined gaps quiet", () => {
  const starts = detectionStarts([at(9000), at(0)]);
  assert.equal(detectingAt(starts, 99999), false);
  assert.equal(detectingAt(starts, 100000), true);
  assert.equal(detectingAt(starts, 102999), true);
  assert.equal(detectingAt(starts, 103000), false);
  assert.equal(detectingAt(starts, 108999), false);
  assert.equal(detectingAt(starts, 109000), true);
  assert.equal(detectingAt(starts, 112000), false);
});
test("backward seeks and overlapping calls work without a forward-only cursor", () => {
  const starts = detectionStarts([at(0), at(2000), at(30000)]);
  assert.equal(detectingAt(starts, 130001), true);
  assert.equal(detectingAt(starts, 104999), true);
  assert.equal(detectingAt(starts, 105000), false);
  assert.equal(detectingAt(starts, 100001), true);
});
test("reviewed rejections and unidentified windows do not become active species", () => {
  const rows = [at(0, {review: "rejected"}), at(10000, {review: "confirmed"}), at(20000, {unidentified: true}), {at: "bad"}];
  const original = structuredClone(rows);
  assert.deepEqual(detectionStarts(rows, d => d.review), [110000]);
  assert.deepEqual(rows, original);
});
test("each species has an independent activity timeline, including simultaneous calls", () => {
  const index = speciesActivity([{detections: [at(0), at(0, {common_name: "Wren"}), at(9000)]}]);
  assert.equal(detectingAt(index.get("Junco"), 100001), true);
  assert.equal(detectingAt(index.get("Wren"), 100001), true);
  assert.equal(detectingAt(index.get("Wren"), 109001), false);
});
test("missing playheads and empty data never light a cue", () => {
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(detectingAt([100000], value), false);
  assert.equal(detectingAt([], 100000), false);
});

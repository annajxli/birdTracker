import test from "node:test";
import assert from "node:assert/strict";
import {log2Axis, LOG2_FLOOR} from "../src/components/log2-axis.js";

test("the axis reaches the next power of two and starts below a count of 1", () => {
  assert.deepEqual(log2Axis(134).domain, [LOG2_FLOOR, 256]);
  assert.deepEqual(log2Axis(128).domain, [LOG2_FLOOR, 128]);
  assert.ok(LOG2_FLOOR < 1);
});

test("ticks are whole powers of two, labeled 2**x, and thinned to fit", () => {
  const axis = log2Axis(134);
  assert.deepEqual(axis.ticks, [1, 4, 16, 64, 256]);
  assert.deepEqual(axis.ticks.map(axis.tickFormat), ["2**0", "2**2", "2**4", "2**6", "2**8"]);
  assert.deepEqual(log2Axis(4).ticks, [1, 2, 4]);
});

test("no data or a single count still gives a usable axis", () => {
  assert.deepEqual(log2Axis(undefined).domain, [LOG2_FLOOR, 2]);
  assert.deepEqual(log2Axis(1).domain, [LOG2_FLOOR, 2]);
});

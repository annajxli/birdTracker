import test from "node:test";
import assert from "node:assert/strict";
import {includedDetection, detectionPlaybackStart, shownInGantt} from "../src/components/detection-policy.js";

test("confirmation admits low scores, rejection excludes high scores, undo restores the threshold", () => {
  assert.equal(includedDetection({confidence: .33, review: "confirmed"}, .6), true);
  assert.equal(includedDetection({confidence: .99, review: "rejected"}, .6), false);
  assert.equal(includedDetection({confidence: .33, review: null}, .6), false);
  assert.equal(includedDetection({confidence: .6}, .6), true);
  assert.equal(includedDetection({confidence: .99, review: null}, .6), true);
  const confirmed = {confidence: .33, review: "confirmed"};
  includedDetection(confirmed, 1);
  assert.equal(confirmed.confidence, .33);
});

test("detection playback has a two-second lead-in", () => {
  assert.equal(detectionPlaybackStart(123000), 121000);
});

test("Gantt shows uncertain detections by default, and its filter respects human reviews", () => {
  const candidate = {confidence: .33, review: null};
  assert.equal(shownInGantt(candidate, false), true);
  assert.equal(shownInGantt(candidate, true), false);
  assert.equal(shownInGantt({...candidate, review: "confirmed"}, true), true);
  for (const confidentOnly of [false, true]) {
    assert.equal(shownInGantt({confidence: .99, review: "rejected"}, confidentOnly), false);
    assert.equal(shownInGantt({confidence: .6}, confidentOnly), true);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {includedDetection, detectionPlaybackStart, shownInGantt, speciesThreshold} from "../src/components/detection-policy.js";

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

test("learned thresholds replace the shared one; blocked species count only when confirmed", () => {
  const thresholds = {
    "Haemorhous mexicanus": {common_name: "House Finch", confirmed: 12, rejected: 0, threshold: .257},
    "Aegolius acadicus": {common_name: "Northern Saw-whet Owl", confirmed: 0, rejected: 210, blocked: true}
  };
  const finch = {scientific: "Haemorhous mexicanus", confidence: .3};
  assert.equal(includedDetection(finch, .6, thresholds), true);
  assert.equal(includedDetection({...finch, confidence: .2}, .6, thresholds), false);
  assert.equal(includedDetection({...finch, review: "rejected"}, .6, thresholds), false);
  const owl = {scientific_name: "Aegolius acadicus", confidence: .99};
  assert.equal(includedDetection(owl, .6, thresholds), false);
  assert.equal(includedDetection({...owl, review: "confirmed"}, .6, thresholds), true);
  // Unlisted species, or no thresholds file: the shared threshold.
  assert.equal(includedDetection({scientific: "Corvus brachyrhynchos", confidence: .5}, .6, thresholds), false);
  assert.equal(includedDetection({scientific: "Corvus brachyrhynchos", confidence: .5}, .45, thresholds), true);
  assert.equal(includedDetection(finch, .6, null), false);
  assert.equal(speciesThreshold("Aegolius acadicus", .6, thresholds), null);
  assert.equal(speciesThreshold("Haemorhous mexicanus", .6, thresholds), .257);
  assert.equal(speciesThreshold("Corvus brachyrhynchos", .6, thresholds), .6);
  assert.equal(shownInGantt(owl, true, .6, thresholds), false);
  assert.equal(shownInGantt(owl, false, .6, thresholds), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {unidentifiedDetections, unidentifiedRuns} from '../src/components/live-unidentified.js';
import {shownInGantt} from '../src/components/detection-policy.js';
test('legacy strips have no invented unidentified events',()=> assert.deepEqual(unidentifiedDetections([{detections:[]}]),[]));
test('adjacent windows merge, gaps stay separate, and no species identity is invented',()=> {
 const strips=[{unidentified:[{at:'2026-10-26T20:35:54Z',seconds:3},{at:'2026-10-26T20:35:57Z',seconds:3},{at:'2026-10-26T20:36:06Z',seconds:3},{at:'invalid'}]}];
 const detections=unidentifiedDetections(strips);
 assert.equal(detections.length,3);
 assert.equal(detections[0].scientific_name,undefined);
 assert.equal(shownInGantt(detections[0],false),true);
 assert.equal(shownInGantt(detections[0],true),false);
 const runs=unidentifiedRuns(strips);assert.equal(runs.length,2);assert.equal(runs[0].end-runs[0].start,6000);
});

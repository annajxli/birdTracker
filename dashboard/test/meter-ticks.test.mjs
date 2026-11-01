import test from 'node:test';
import assert from 'node:assert/strict';
import {spreadLabels} from '../src/components/meter-ticks.js';

test('labels with room stay centered on their marks', () => {
  assert.deepEqual(spreadLabels([{center: 30, width: 20}, {center: 80, width: 20}], 120), [20, 70]);
});

test('two overlapping labels move apart evenly', () => {
  // Wanted lefts 40 and 50; together they need 20 + 4 + 20.
  assert.deepEqual(spreadLabels([{center: 50, width: 20}, {center: 60, width: 20}], 200), [33, 57]);
});

test('labels stay inside the span', () => {
  assert.deepEqual(spreadLabels([{center: 2, width: 20}], 100), [0]);
  assert.deepEqual(spreadLabels([{center: 98, width: 20}], 100), [80]);
  // Packet success on a phone: 98% and 99.5% near the right end.
  const [a, b] = spreadLabels([{center: 96, width: 22}, {center: 114, width: 30}], 120);
  assert.equal(b + 30, 120);
  assert.equal(a + 22 + 4, b);
});

test('a merged group pulls in a third label it reaches', () => {
  const lefts = spreadLabels([{center: 20, width: 20}, {center: 64, width: 20}, {center: 70, width: 20}], 200);
  assert.deepEqual(lefts, [10, 45, 69]);
  const lefts2 = spreadLabels([{center: 40, width: 20}, {center: 52, width: 20}, {center: 64, width: 20}], 200);
  assert.deepEqual(lefts2, [18, 42, 66]);
});

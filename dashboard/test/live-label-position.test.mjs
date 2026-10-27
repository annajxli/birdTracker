import test from 'node:test';
import assert from 'node:assert/strict';
import {liveLabelLeft} from '../src/components/live-label-position.js';
test('incoming label stays right aligned until its detection reaches its left edge', () => {
  assert.equal(liveLabelLeft(980, 200, 0, 1000), 800);
  assert.equal(liveLabelLeft(900, 200, 0, 1000), 800);
  assert.equal(liveLabelLeft(800, 200, 0, 1000), 800);
  assert.equal(liveLabelLeft(700, 200, 0, 1000), 700);
});
test('viewport movement uses track coordinates and preserves the left boundary', () => {
  assert.equal(liveLabelLeft(1980, 200, 1000, 2000), 1800);
  assert.equal(liveLabelLeft(950, 200, 1000, 2000), 1000);
});

test('leading activity cue reserves viewport space without offsetting aligned names', () => {
  assert.equal(liveLabelLeft(700, 200, 0, 1000, 11), 700);
  assert.equal(liveLabelLeft(980, 200, 0, 1000, 11), 800);
  assert.equal(liveLabelLeft(800, 200, 0, 1000, 11), 800);
  assert.equal(liveLabelLeft(0, 200, 0, 1000, 11), 11);
});

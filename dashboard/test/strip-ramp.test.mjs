import test from 'node:test';
import assert from 'node:assert/strict';
import {stripSeverity, mixOklab} from '../src/components/strip-ramp.js';

const CPU = [[0, 75, 'good'], [75, 90, 'warning'], [90, 100, 'critical']];
const STORAGE = [[0, 5, 'critical'], [5, 15, 'warning'], [15, 100, 'good']];
const BACKGROUND = [[-95, -85, 'critical'], [-85, -62, 'good'], [-62, -56, 'warning'], [-56, -25, 'critical']];

test('a good reading far from trouble is 0', () => {
  assert.equal(stripSeverity(20, CPU), 0);
  assert.equal(stripSeverity(60, CPU), 0); // one Okay width (15) before 75
  assert.equal(stripSeverity(80, STORAGE), 0);
});

test('a good reading warms over one neighboring zone width', () => {
  assert.equal(stripSeverity(67.5, CPU), 0.5);
  assert.equal(stripSeverity(20, STORAGE), 0.5);
  assert.equal(stripSeverity(-65, BACKGROUND), 0.5);
});

test('it is continuous at each threshold and reaches 2 where Bad starts', () => {
  assert.equal(stripSeverity(75, CPU), 1);
  assert.ok(Math.abs(stripSeverity(74.999, CPU) - 1) < 1e-3);
  assert.equal(stripSeverity(82.5, CPU), 1.5);
  assert.equal(stripSeverity(90, CPU), 2);
  assert.equal(stripSeverity(10, STORAGE), 1.5);
  assert.equal(stripSeverity(3, STORAGE), 2);
});

test('a Good zone next to a Bad zone warms toward 2', () => {
  assert.equal(stripSeverity(-80, BACKGROUND), 1);
  assert.equal(stripSeverity(-90, BACKGROUND), 2);
});

test('readings off the scale are clamped', () => {
  assert.equal(stripSeverity(150, CPU), 2);
  assert.equal(stripSeverity(-10, CPU), 0);
});

test('mixOklab returns its ends and round-trips colors', () => {
  assert.equal(mixOklab('#0ca30c', '#fab219', 0), '#0ca30c');
  assert.equal(mixOklab('#0ca30c', '#fab219', 1), '#fab219');
  assert.equal(mixOklab('#a82a2a', '#a82a2a', 0.5), '#a82a2a');
  assert.equal(mixOklab('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixOklab('#000000', '#ffffff', 1), '#ffffff');
});

test('mixOklab blends black and white to OKLab middle gray', () => {
  // OKLab L 0.5 is sRGB about #636363 (L is cube-root-like, so darker than #808080).
  assert.equal(mixOklab('#000000', '#ffffff', 0.5), '#636363');
});

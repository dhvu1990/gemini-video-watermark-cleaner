import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseAlphaProfileForSize,
  normalizeDetectedAlphaMap,
  resolveDetectedAlphaGain
} from '../src/video/detectionProfileReuse.js';

test('detected alpha map is validated and cloned before export reuse', () => {
  const source = new Float32Array(16 * 16).fill(0.25);
  const normalized = normalizeDetectedAlphaMap(source, 16, 16);
  assert.ok(normalized instanceof Float32Array);
  assert.notEqual(normalized, source);
  assert.deepEqual(Array.from(normalized), Array.from(source));
  source[0] = 0.75;
  assert.equal(normalized[0], 0.25);
});

test('invalid detected alpha geometry and values are rejected', () => {
  assert.equal(normalizeDetectedAlphaMap(new Float32Array(15), 4, 4), null);
  const nonFinite = new Float32Array(16).fill(0.2);
  nonFinite[3] = Number.NaN;
  assert.equal(normalizeDetectedAlphaMap(nonFinite, 4, 4), null);
  const outOfRange = new Float32Array(16).fill(0.2);
  outOfRange[4] = 1.2;
  assert.equal(normalizeDetectedAlphaMap(outOfRange, 4, 4), null);
});

test('base fallback profile is explicit and independent of active calibration state', () => {
  assert.equal(baseAlphaProfileForSize(32), '48');
  assert.equal(baseAlphaProfileForSize(72), '96-20260520');
});

test('default UI gain reuses detector calibration while explicit operator gain wins', () => {
  assert.equal(resolveDetectedAlphaGain(1, 0.84, 1), 0.84);
  assert.equal(resolveDetectedAlphaGain(1.12, 0.84, 1), 1.12);
  assert.equal(resolveDetectedAlphaGain(1, null, 1), 1);
});

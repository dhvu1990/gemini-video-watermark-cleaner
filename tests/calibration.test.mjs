import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdgeGain, residualEdgeScore, scaleAlphaShape } from '../src/video/calibration.js';

function diamondAlpha(size) {
  const out = new Float32Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = (Math.abs(x - c) + Math.abs(y - c)) / c;
      out[y * size + x] = Math.max(0, Math.min(0.55, (1.05 - d) * 0.5));
    }
  }
  return out;
}

function image(size, value = 80) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { width: size, height: size, data };
}

test('shape scale expands alpha footprint without changing dimensions', () => {
  const size = 24;
  const alpha = diamondAlpha(size);
  const expanded = scaleAlphaShape(alpha, size, 1.03);
  assert.equal(expanded.length, alpha.length);
  const originalSum = alpha.reduce((a, b) => a + b, 0);
  const expandedSum = expanded.reduce((a, b) => a + b, 0);
  assert.ok(expandedSum > originalSum);
});

test('edge gain strengthens edge-weighted alpha while preserving center bounds', () => {
  const size = 24;
  const alpha = diamondAlpha(size);
  const stronger = applyEdgeGain(alpha, size, 1.3);
  assert.equal(stronger.length, alpha.length);
  assert.ok(Math.max(...stronger) <= 0.95);
  assert.ok(stronger.some((value, index) => value > alpha[index] + 1e-5));
});

test('residual score penalizes a strong artificial edge', () => {
  const size = 24;
  const alpha = diamondAlpha(size);
  const original = image(size, 80);
  const clean = image(size, 80);
  const edged = image(size, 80);
  for (let y = 0; y < size; y++) {
    for (let x = Math.floor(size / 2); x < size; x++) {
      const i = (y * size + x) * 4;
      edged.data[i] = edged.data[i + 1] = edged.data[i + 2] = 150;
    }
  }
  assert.ok(residualEdgeScore(original, edged, alpha) > residualEdgeScore(original, clean, alpha));
});

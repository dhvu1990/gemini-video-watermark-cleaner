import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEdgeGain,
  backgroundContinuityScore,
  bodyGainCandidates,
  residualBucketScores,
  residualEdgeScore,
  scaleAlphaShape,
  transformAlphaRegistration
} from '../src/video/calibration.js';
import { inverseAlphaRestore } from '../src/video/restore.js';

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

function compositeWhite(background, alpha, gain = 1) {
  const out = { width: background.width, height: background.height, data: new Uint8ClampedArray(background.data) };
  for (let p = 0; p < alpha.length; p++) {
    const a = Math.min(0.95, alpha[p] * gain);
    const i = p * 4;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(background.data[i + c] * (1 - a) + 255 * a);
  }
  return out;
}

function centerOfMassX(alpha, size) {
  let weighted = 0;
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = alpha[y * size + x] || 0;
      weighted += x * a;
      sum += a;
    }
  }
  return sum ? weighted / sum : 0;
}

test('shape scale expands alpha footprint without changing dimensions', () => {
  const size = 24;
  const alpha = diamondAlpha(size);
  const expanded = scaleAlphaShape(alpha, size, 1.03);
  assert.equal(expanded.length, alpha.length);
  assert.ok(expanded.reduce((a, b) => a + b, 0) > alpha.reduce((a, b) => a + b, 0));
});

test('subpixel registration shifts alpha footprint without changing dimensions', () => {
  const size = 32;
  const alpha = diamondAlpha(size);
  const shifted = transformAlphaRegistration(alpha, size, { offsetX: 0.4, offsetY: -0.4 });
  assert.equal(shifted.length, alpha.length);
  assert.ok(centerOfMassX(shifted, size) > centerOfMassX(alpha, size));
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

test('residual buckets isolate edge damage from body damage', () => {
  const size = 32;
  const alpha = diamondAlpha(size);
  const original = image(size, 90);
  const cleaned = image(size, 90);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const p = y * size + x;
      const a = alpha[p] || 0;
      if (a > 0.03 && a < 0.16) {
        const i = p * 4;
        cleaned.data[i] = cleaned.data[i + 1] = cleaned.data[i + 2] = 145;
      }
    }
  }
  const buckets = residualBucketScores(original, cleaned, alpha);
  assert.ok(Number.isFinite(buckets.total));
  assert.ok(buckets.edge > buckets.highBody);
});

test('body gain candidates search below an overestimated detector gain', () => {
  const values = bodyGainCandidates(1.125);
  assert.ok(values.some((value) => value < 0.95));
  assert.ok(values.includes(1));
  assert.ok(values.every((value) => value >= 0.55 && value <= 1.35));
});

test('background continuity penalizes over-clean dark center', () => {
  const size = 32;
  const alpha = diamondAlpha(size);
  const background = image(size, 90);
  const observed = compositeWhite(background, alpha, 0.82);
  const correct = inverseAlphaRestore(observed, alpha, 0.82);
  const over = inverseAlphaRestore(observed, alpha, 1.18);
  const correctScore = backgroundContinuityScore(observed, correct, alpha);
  const overScore = backgroundContinuityScore(observed, over, alpha);
  assert.ok(correctScore < overScore);
});

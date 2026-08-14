import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProceduralFallbackAlpha } from '../src/video/alpha.js';
import { applyDirectionalEdgeReconstruction, inverseAlphaRestore } from '../src/video/restore.js';

function makeBackground(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = 45 + ((x * 3 + y) % 70);
      data[i + 1] = 65 + ((x + y * 2) % 65);
      data[i + 2] = 85 + ((x * 2 + y * 3) % 55);
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function makeSmoothBackground(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = 42 + Math.round(x * 0.7 + y * 0.15);
      data[i + 1] = 92 + Math.round(x * 0.35 + y * 0.2);
      data[i + 2] = 150 + Math.round(x * 0.55 + y * 0.1);
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function addWhiteAlphaOverlay(background, alpha) {
  const data = new Uint8ClampedArray(background.data);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p];
    const i = p * 4;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(background.data[i + c] * (1 - a) + 255 * a);
  }
  return { width: background.width, height: background.height, data };
}

function meanAbsRgbError(a, b) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      count++;
    }
  }
  return sum / count;
}

function lowAlphaBand(alpha) {
  return alpha.map((value) => value >= 0.015 && value <= 0.22);
}

test('inverse alpha restoration approximately reconstructs original pixels', () => {
  const size = 48;
  const alpha = buildProceduralFallbackAlpha(size);
  const original = makeBackground(size);
  const watermarked = addWhiteAlphaOverlay(original, alpha);
  const restored = inverseAlphaRestore(watermarked, alpha, 1);
  assert.ok(meanAbsRgbError(original, restored) < 1.1);
});

test('directional reconstruction reduces a dark residual edge on a smooth background', () => {
  const size = 48;
  const alpha = buildProceduralFallbackAlpha(size);
  const original = makeSmoothBackground(size);
  const damaged = { width: size, height: size, data: new Uint8ClampedArray(original.data) };
  const band = lowAlphaBand(alpha);
  for (let p = 0; p < band.length; p++) {
    if (!band[p]) continue;
    const i = p * 4;
    damaged.data[i] = Math.max(0, damaged.data[i] - 34);
    damaged.data[i + 1] = Math.max(0, damaged.data[i + 1] - 34);
    damaged.data[i + 2] = Math.max(0, damaged.data[i + 2] - 34);
  }
  const repaired = applyDirectionalEdgeReconstruction(damaged, alpha, 0.9);
  assert.ok(meanAbsRgbError(original, repaired) < meanAbsRgbError(original, damaged));
});

test('directional reconstruction preserves a strong real structure crossing the ROI', () => {
  const size = 48;
  const alpha = buildProceduralFallbackAlpha(size);
  const original = makeSmoothBackground(size);
  const structured = { width: size, height: size, data: new Uint8ClampedArray(original.data) };
  const x = Math.floor(size / 2);
  for (let y = 0; y < size; y++) {
    const i = (y * size + x) * 4;
    structured.data[i] = 235;
    structured.data[i + 1] = 235;
    structured.data[i + 2] = 235;
  }
  const repaired = applyDirectionalEdgeReconstruction(structured, alpha, 0.9);
  let delta = 0;
  for (let y = 2; y < size - 2; y++) {
    const i = (y * size + x) * 4;
    delta += Math.abs(repaired.data[i] - structured.data[i]);
  }
  assert.ok(delta / (size - 4) < 8);
});

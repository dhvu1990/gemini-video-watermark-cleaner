import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSmoothBackground, applySmoothBackgroundReconstruction } from '../src/video/smoothBackground.js';
import { classifyNearEmptyBackground, applySafeEmptyZoneHardSuppression } from '../src/video/emptyZoneHardSuppress.js';
import { measurePostCleanupResidual } from '../src/video/edgeBridge.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 14) alpha[y * width + x] = 0.52;
      else if (d <= 17) alpha[y * width + x] = 0.23;
      else if (d <= 20) alpha[y * width + x] = 0.07;
      else if (d <= 22) alpha[y * width + x] = 0.018;
    }
  }
  return alpha;
}

function overlayWhite(clean, alpha) {
  const out = new Uint8ClampedArray(clean.data);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] || 0;
    if (a <= 0) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(clean.data[i + c] * (1 - a) + 255 * a);
  }
  return { width: clean.width, height: clean.height, data: out };
}

test('USB-C-like smooth gradient qualifies for near-empty hard suppression', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const clean = makeImage(width, height, (x, y) => [
    35 + x * 0.55 + y * 0.08,
    102 + x * 0.30 + y * 0.20,
    170 + x * 0.22 - y * 0.06
  ]);
  const watermarked = overlayWhite(clean, alpha);
  const analysis = analyzeSmoothBackground(watermarked, alpha);
  const classification = classifyNearEmptyBackground(analysis);
  assert.equal(analysis.safe, true, JSON.stringify(analysis));
  assert.equal(classification.eligible, true, JSON.stringify({ analysis, classification }));
});

test('hard suppression is try-and-accept and never returns a materially worse residual', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const clean = makeImage(width, height, (x, y) => [
    42 + x * 0.45 + y * 0.05,
    98 + x * 0.28 + y * 0.18,
    166 + x * 0.24 - y * 0.04
  ]);
  const watermarked = overlayWhite(clean, alpha);
  const analysis = analyzeSmoothBackground(watermarked, alpha);
  const first = applySmoothBackgroundReconstruction(watermarked, alpha, analysis, {
    strength: 0.94,
    dilationRadius: 4,
    microSmooth: 0.14
  });
  const before = measurePostCleanupResidual(first, alpha);
  const hard = applySafeEmptyZoneHardSuppression(first, alpha, analysis);
  const after = measurePostCleanupResidual(hard, alpha);
  assert.equal(hard.emptyZoneHard.eligible, true);
  assert.equal(hard.emptyZoneHard.attempted, true);
  assert.ok(after.total <= before.total * 1.001, `${before.total} -> ${after.total}`);
  if (hard.emptyZoneHard.accepted) {
    assert.ok(hard.emptyZoneHard.candidateAfter.total < before.total, 'accepted hard pass must improve total residual');
  }
});

test('keyboard-like structured content is never eligible for empty-zone hard suppression', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const structured = makeImage(width, height, (x, y) => {
    const row = Math.floor(y / 8) % 2;
    const col = Math.floor(x / 11) % 2;
    const diagonal = Math.abs(((x + y * 2) % 27) - 13) < 2 ? 52 : 0;
    const grid = (x % 11 < 2 || y % 8 < 2) ? 34 : 0;
    const base = 42 + row * 14 + col * 10;
    return [base + grid + diagonal, 70 + grid + diagonal, 112 + grid + diagonal];
  });
  const analysis = analyzeSmoothBackground(structured, alpha);
  const classification = classifyNearEmptyBackground(analysis);
  const hard = applySafeEmptyZoneHardSuppression(structured, alpha, analysis);
  assert.equal(classification.eligible, false);
  assert.equal(hard.emptyZoneHard.attempted, false);
  assert.equal(hard.emptyZoneHard.accepted, false);
});

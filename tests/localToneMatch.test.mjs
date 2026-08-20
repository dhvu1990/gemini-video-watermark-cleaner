import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLocalToneMatch, measureLocalToneMismatch } from '../src/video/localToneMatch.js';

function image(width, height, fn) {
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
      if (d <= 8) alpha[y * width + x] = 0.52;
      else if (d <= 10) alpha[y * width + x] = 0.20;
      else if (d <= 12) alpha[y * width + x] = 0.06;
    }
  }
  return alpha;
}

test('local tone match reduces a uniform luma offset on a smooth gradient', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const base = image(width, height, (x, y) => [92 + x * 0.55, 122 + y * 0.32, 148 + x * 0.20]);
  const damaged = { width, height, data: new Uint8ClampedArray(base.data) };
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 0.07 || alpha[p] > 0.68) continue;
    const i = p * 4;
    damaged.data[i] += 7; damaged.data[i + 1] += 7; damaged.data[i + 2] += 7;
  }
  const before = measureLocalToneMismatch(damaged, alpha);
  const result = applyLocalToneMatch(damaged, alpha, { strength: 0.80 });
  const after = measureLocalToneMismatch(result, alpha);
  assert.ok(before.score > 2.5);
  assert.equal(result.localToneMatch.attempted, true);
  assert.equal(result.localToneMatch.accepted, true);
  assert.ok(after.score < before.score);
  assert.ok(result.localToneMatch.correctedPixels > 0);
});

test('quadrant-aware tone field detects opposite footprint offsets without forcing one global shift', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const base = image(width, height, (x, y) => [104 + x * 0.22, 126 + y * 0.18, 146 + x * 0.12]);
  const damaged = { width, height, data: new Uint8ClampedArray(base.data) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (alpha[p] < 0.07 || alpha[p] > 0.68) continue;
      const shift = y < height / 2 ? 7 : -5;
      const i = p * 4;
      damaged.data[i] += shift; damaged.data[i + 1] += shift; damaged.data[i + 2] += shift;
    }
  }
  const before = measureLocalToneMismatch(damaged, alpha);
  const result = applyLocalToneMatch(damaged, alpha, { strength: 0.78, sectorMix: 0.78, minScore: 0.6 });
  assert.ok(before.sectorSpread > 5, JSON.stringify(before));
  assert.equal(result.localToneMatch.attempted, true);
  if (result.localToneMatch.accepted) {
    assert.ok(result.localToneMatch.meanSectorAdaptation > 0);
    assert.ok(result.localToneMatch.candidateImprovement > 0);
  }
});

test('local tone match backs off on a high-detail checkerboard scene', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const detailed = image(width, height, (x, y) => {
    const v = (x + y) % 2 ? 65 : 190;
    return [v, Math.min(255, v + 15), Math.max(0, v - 12)];
  });
  const before = new Uint8ClampedArray(detailed.data);
  const result = applyLocalToneMatch(detailed, alpha);
  assert.equal(result.localToneMatch.accepted, false);
  assert.deepEqual(Array.from(result.data), Array.from(before));
});

test('invalid alpha geometry returns an unchanged no-op', () => {
  const src = image(16, 16, () => [100, 120, 140]);
  const result = applyLocalToneMatch(src, new Float32Array(8));
  assert.equal(result.localToneMatch.enabled, false);
  assert.deepEqual(Array.from(result.data), Array.from(src.data));
});

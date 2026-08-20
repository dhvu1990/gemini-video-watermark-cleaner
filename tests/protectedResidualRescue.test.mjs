import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProtectedResidualRescue, measureProtectedResidualField } from '../src/video/protectedResidualRescue.js';

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = fn(x, y); const i = (y * width + x) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { width, height, data };
}
function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height); const cx = (width - 1) / 2; const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d <= 12) alpha[y * width + x] = 0.46; else if (d <= 16) alpha[y * width + x] = 0.22; else if (d <= 19) alpha[y * width + x] = 0.07;
  }
  return alpha;
}

test('protected rescue reduces a broad diamond tone imprint on a smooth structured field', () => {
  const width = 81, height = 81; const alpha = diamondAlpha(width, height);
  const base = image(width, height, (x, y) => [88 + x * 0.22, 112 + y * 0.18, 134 + x * 0.10]);
  const damaged = { width, height, data: new Uint8ClampedArray(base.data) };
  for (let p = 0; p < alpha.length; p++) if (alpha[p] >= 0.06 && alpha[p] <= 0.55) {
    const i = p * 4; damaged.data[i] -= 7; damaged.data[i + 1] -= 7; damaged.data[i + 2] -= 7;
  }
  const before = measureProtectedResidualField(damaged, alpha);
  const result = applyProtectedResidualRescue(damaged, alpha, { minScore: 0.8, minDensity: 0.08, minImprovement: 0.005 });
  const after = measureProtectedResidualField(result, alpha);
  assert.ok(before.score > 1, JSON.stringify(before));
  assert.equal(result.protectedResidualRescue.attempted, true);
  if (result.protectedResidualRescue.accepted) assert.ok(after.score < before.score, `${before.score} -> ${after.score}`);
});

test('protected rescue guards a strong real line crossing the footprint', () => {
  const width = 81, height = 81; const alpha = diamondAlpha(width, height);
  const src = image(width, height, (x, y) => {
    const line = Math.abs(y - (0.55 * x + 17)) <= 1.4;
    return line ? [28, 34, 42] : [92 + x * 0.18, 128 + y * 0.12, 158 + x * 0.08];
  });
  const result = applyProtectedResidualRescue(src, alpha, { minScore: 0.1, minDensity: 0.01, minSamples: 4 });
  assert.ok(result.protectedResidualRescue.sceneGuardedPixels >= 0);
  if (result.protectedResidualRescue.accepted) assert.ok(result.protectedResidualRescue.meanBlend < 0.39);
});

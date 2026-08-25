import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSmoothRebuildArtifactGuard } from '../src/video/smoothRebuildArtifactGuard.js';

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = fn(x, y); const i = (y * width + x) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { width, height, data };
}

function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2; const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d <= 12) alpha[y * width + x] = 0.46;
    else if (d <= 16) alpha[y * width + x] = 0.22;
    else if (d <= 19) alpha[y * width + x] = 0.07;
  }
  return alpha;
}

test('smooth rebuild artifact guard rolls back a new dense diamond blotch', () => {
  const width = 81, height = 81; const alpha = diamondAlpha(width, height);
  const before = image(width, height, (x, y) => [72 + x * 0.12, 88 + y * 0.10, 104 + x * 0.08]);
  const candidate = { width, height, data: new Uint8ClampedArray(before.data) };
  for (let p = 0; p < alpha.length; p++) if (alpha[p] >= 0.06 && alpha[p] <= 0.55) {
    const i = p * 4;
    candidate.data[i] -= 11; candidate.data[i + 1] -= 11; candidate.data[i + 2] -= 11;
  }
  const guard = evaluateSmoothRebuildArtifactGuard(before, candidate, alpha, {
    minResidualScore: 0.8,
    minDensity: 0.06,
    minSamples: 8,
    minExpectedImprovement: 0.05
  });
  assert.equal(guard.rollback, true, JSON.stringify(guard));
  assert.ok(guard.afterField.score > guard.beforeField.score, JSON.stringify(guard));
});

test('smooth rebuild artifact guard leaves a clean candidate alone', () => {
  const width = 81, height = 81; const alpha = diamondAlpha(width, height);
  const clean = image(width, height, (x, y) => [94 + x * 0.10, 116 + y * 0.08, 138 + x * 0.06]);
  const guard = evaluateSmoothRebuildArtifactGuard(clean, clean, alpha);
  assert.equal(guard.rollback, false, JSON.stringify(guard));
});

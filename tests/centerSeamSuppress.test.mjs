import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCenterSeamSuppression, measureCenterSeamResidual } from '../src/video/centerSeamSuppress.js';

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
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const sx = width * 0.34;
  const sy = height * 0.34;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) / sx + Math.abs(y - cy) / sy;
      if (d <= 0.55) alpha[y * width + x] = 0.52;
      else if (d <= 0.82) alpha[y * width + x] = 0.28;
      else if (d <= 1.0) alpha[y * width + x] = 0.10;
    }
  }
  return alpha;
}

function meanAbsDelta(a, b, predicate = null) {
  let sum = 0, count = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    if (predicate && !predicate(p)) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

test('center seam suppression reduces a narrow vertical ghost on a smooth background', () => {
  const width = 52, height = 52;
  const alpha = diamondAlpha(width, height);
  const cx = Math.round((width - 1) * 0.5);
  const clean = image(width, height, (x, y) => {
    const base = 122 + Math.round(x * 0.22 + y * 0.08);
    return [base + 8, base + 2, base - 4];
  });
  const damaged = image(width, height, (x, y) => {
    const i = (y * width + x) * 4;
    const a = alpha[y * width + x];
    const seam = a > 0.05 && Math.abs(x - cx) <= 1 ? 10 : 0;
    return [clean.data[i] + seam, clean.data[i + 1] + seam, clean.data[i + 2] + seam];
  });

  const before = measureCenterSeamResidual(damaged, alpha, { minScore: 0.1 });
  const result = applyCenterSeamSuppression(damaged, alpha, { minScore: 0.1, minImprovement: 0.002 });
  const info = result.centerSeam;
  assert.equal(info.attempted, true);
  assert.ok(info.candidateAfter.score < before.score);
  if (info.accepted) {
    assert.ok(info.after.score < before.score);
    const seamMask = (p) => {
      const x = p % width;
      return Math.abs(x - cx) <= 1 && alpha[p] > 0.05;
    };
    assert.ok(meanAbsDelta(result, clean, seamMask) < meanAbsDelta(damaged, clean, seamMask));
  }
});

test('center seam suppression protects a genuine strong vertical scene edge', () => {
  const width = 52, height = 52;
  const alpha = diamondAlpha(width, height);
  const cx = Math.round((width - 1) * 0.5);
  const source = image(width, height, (x, y) => {
    const left = 72 + Math.round(y * 0.08);
    const right = 168 + Math.round(y * 0.08);
    const base = x <= cx ? left : right;
    return [base, base + 5, base + 10];
  });

  const before = measureCenterSeamResidual(source, alpha);
  const result = applyCenterSeamSuppression(source, alpha);
  const info = result.centerSeam;
  if (before.samples < 8 || before.score < 0.95) {
    assert.equal(info.attempted, false);
  }
  assert.ok(meanAbsDelta(result, source) < 0.35);
});

test('invalid alpha geometry is returned unchanged', () => {
  const source = image(20, 20, () => [90, 100, 110]);
  const badAlpha = new Float32Array(10);
  const result = applyCenterSeamSuppression(source, badAlpha);
  assert.equal(result.centerSeam.enabled, false);
  assert.equal(meanAbsDelta(result, source), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStructuredFootprintResidual } from '../src/video/structuredFootprintDiagnostics.js';

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
      if (d <= 13) alpha[y * width + x] = Math.max(0.03, 0.66 * (1 - d / 16));
      else if (d <= 16) alpha[y * width + x] = 0.018 * (17 - d);
    }
  }
  return alpha;
}

function addDiamondGhost(base, alpha, amount = 28) {
  return image(base.width, base.height, (x, y) => {
    const p = y * base.width + x;
    const i = p * 4;
    const a = alpha[p] || 0;
    const ghost = a > 0.02 ? amount * Math.min(1, a / 0.34) : 0;
    return [base.data[i] + ghost, base.data[i + 1] + ghost, base.data[i + 2] + ghost];
  });
}

test('broad diamond-correlated tonal ghost scores above clean background', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const clean = image(width, height, (x, y) => [78 + x * 0.45, 92 + y * 0.35, 108 + x * 0.25]);
  const ghost = addDiamondGhost(clean, alpha, 30);
  const cleanMetric = measureStructuredFootprintResidual(clean, alpha);
  const ghostMetric = measureStructuredFootprintResidual(ghost, alpha);
  assert.ok(ghostMetric.score > cleanMetric.score + 0.35);
  assert.ok(ghostMetric.shapeAlignedDensity > cleanMetric.shapeAlignedDensity);
  assert.ok(ghostMetric.samples > 0);
});

test('clean smooth structured region remains low', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const clean = image(width, height, (x, y) => [82 + x * 0.35, 96 + y * 0.28, 112 + (x + y) * 0.12]);
  const metric = measureStructuredFootprintResidual(clean, alpha);
  assert.ok(metric.score < 1.2);
  assert.ok(metric.shapeAlignedDensity < 0.08);
});

test('real scene boundary crossing watermark is discounted by continuity guard', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const boundary = image(width, height, (x, y) => x < 31 ? [92, 72, 54] : [38, 34, 32]);
  const metric = measureStructuredFootprintResidual(boundary, alpha);
  assert.ok(metric.rawScore >= metric.score);
  assert.ok(metric.continuityMean > 0.15);
  assert.ok(metric.score < metric.rawScore * 0.9 + 1e-9);
});

test('high-frequency texture without shape-correlated footprint does not dominate score', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height);
  const textured = image(width, height, (x, y) => {
    const stripe = ((x * 3 + y * 5) % 7) < 3 ? 18 : -18;
    return [96 + stripe, 88 - stripe * 0.4, 78 + stripe * 0.25];
  });
  const metric = measureStructuredFootprintResidual(textured, alpha);
  assert.ok(metric.score < 3.5);
  assert.ok(metric.coverage < 0.25);
});

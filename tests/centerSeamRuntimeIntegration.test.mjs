import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredResidualRingSuppression } from '../src/video/structuredRingSuppress.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fn(x, y);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width, height) {
  const out = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = Math.min(width, height) * 0.38;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
      out[y * width + x] = d < 1 ? Math.max(0.06, 0.48 * (1 - d) + 0.08) : 0;
    }
  }
  return out;
}

test('structured runtime exposes center-seam diagnostics after shape/ring finishing', () => {
  const width = 48, height = 48;
  const alpha = diamondAlpha(width, height);
  const cx = Math.round((width - 1) / 2);
  const source = makeImage(width, height, (x, y) => {
    const base = 126 + Math.round(x * 0.12 + y * 0.05);
    const seam = Math.abs(x - cx) <= 1 && alpha[y * width + x] > 0.055 ? 12 : 0;
    return [base + seam, base + seam, base + seam];
  });

  const result = applyStructuredResidualRingSuppression(source, alpha, {
    consensus: false,
    shapeGhost: false,
    totalThreshold: 999,
    lumaThreshold: 999,
    centerSeamOptions: {
      minScore: 0.15,
      minResidual: 0.1,
      fullResidual: 2.0,
      minImprovement: 0.001,
      strength: 0.65
    }
  });

  assert.ok(result.structuredRing.centerSeam);
  assert.equal(result.structuredRing.centerSeam.enabled, true);
  assert.equal(typeof result.structuredRing.centerSeam.attempted, 'boolean');
  assert.equal(typeof result.structuredRing.centerSeam.accepted, 'boolean');
  if (result.structuredRing.centerSeam.accepted) {
    assert.match(result.structuredRing.acceptedMode, /center-seam/);
    assert.ok(result.structuredRing.centerSeam.after.score < result.structuredRing.centerSeam.before.score);
  }
});

test('structured runtime can explicitly disable center-seam finishing', () => {
  const width = 24, height = 24;
  const alpha = diamondAlpha(width, height);
  const source = makeImage(width, height, () => [140, 145, 150]);
  const result = applyStructuredResidualRingSuppression(source, alpha, {
    consensus: false,
    shapeGhost: false,
    centerSeam: false,
    totalThreshold: 999,
    lumaThreshold: 999
  });
  assert.equal(result.structuredRing.centerSeam.enabled, false);
  assert.equal(result.structuredRing.centerSeam.accepted, false);
});

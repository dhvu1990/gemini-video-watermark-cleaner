import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShapeGhostSuppression, measureShapeGhostResidual } from '../src/video/shapeGhostSuppress.js';
import { applyStructuredResidualRingSuppression } from '../src/video/structuredRingSuppress.js';

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

function softDiamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 12) alpha[y * width + x] = Math.max(0.04, 0.64 * (1 - d / 15));
      else if (d <= 14) alpha[y * width + x] = 0.025 * (15 - d);
    }
  }
  return alpha;
}

function meanDelta(a, b) {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (a.width * a.height * 3);
}

test('shape ghost suppression reduces a diamond-aligned residual on a smooth structured gradient', () => {
  const width = 56, height = 56;
  const alpha = softDiamondAlpha(width, height);
  const clean = image(width, height, (x, y) => [72 + x * 2, 92 + Math.floor(y * 1.3), 120 + Math.floor((x + y) * 0.55)]);
  const damaged = image(width, height, (x, y) => {
    const p = y * width + x;
    const i = p * 4;
    const a = alpha[p];
    const ghost = a > 0.06 ? Math.round(5 + a * 28) : 0;
    return [clean.data[i] + ghost, clean.data[i + 1] + ghost, clean.data[i + 2] + ghost];
  });

  const before = measureShapeGhostResidual(damaged, alpha);
  const result = applyShapeGhostSuppression(damaged, alpha, { strength: 0.60 });
  const info = result.shapeGhost;
  assert.ok(before.samples >= 8);
  assert.equal(info.attempted, true);
  assert.equal(info.accepted, true);
  assert.ok(info.after.score < info.before.score * 0.988);
  assert.ok(info.correctedPixels > 0);
  assert.ok(meanDelta(result, damaged) > 0);
});

test('shape ghost suppression preserves exact input when a high-detail scene cannot pass the safety gate', () => {
  const width = 56, height = 56;
  const alpha = softDiamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const stripe = ((x + y) % 4) < 2 ? 210 : 42;
    return [stripe, (x * 17 + y * 9) % 235, (x * 7 + y * 21) % 235];
  });
  const result = applyShapeGhostSuppression(source, alpha, { strength: 0.72 });
  const info = result.shapeGhost;
  if (info.accepted) {
    assert.ok(info.after.score < info.before.score);
    assert.ok(info.outerAfter.total <= info.outerBefore.total * 1.006 + 1e-9);
  } else {
    assert.equal(meanDelta(result, source), 0);
  }
});

test('structured fallback exposes shape ghost diagnostics even when ring thresholds skip the ring pass', () => {
  const width = 56, height = 56;
  const alpha = softDiamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p];
    const base = [96 + x, 112 + Math.floor(y * 0.5), 132 + Math.floor(x * 0.4)];
    const ghost = a > 0.08 ? Math.round(a * 22) : 0;
    return [base[0] + ghost, base[1] + ghost, base[2] + ghost];
  });
  const result = applyStructuredResidualRingSuppression(source, alpha, {
    consensus: false,
    totalThreshold: 999,
    lumaThreshold: 999,
    shapeGhostOptions: { strength: 0.60 }
  });
  assert.ok(result.structuredRing.shapeGhost);
  assert.equal(typeof result.structuredRing.shapeGhost.accepted, 'boolean');
});

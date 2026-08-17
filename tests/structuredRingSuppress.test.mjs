import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStructuredResidualRingSuppression,
  measureStructuredRingResidual
} from '../src/video/structuredRingSuppress.js';
import { applyDualRingLumaFinish } from '../src/video/dualRingFinish.js';

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
      if (d <= 5) alpha[y * width + x] = 0.58;
      else if (d <= 7) alpha[y * width + x] = 0.22;
      else if (d <= 9) alpha[y * width + x] = 0.055;
    }
  }
  return alpha;
}

function ringDamaged(width, height, alpha) {
  return image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p] || 0;
    const base = [60 + x * 2, 78 + y, 116 + ((x + y) % 5)];
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const ring = a > 0.004 && a < 0.30 && d >= 5 && d <= 9;
    const halo = ring ? 16 : 0;
    return [base[0] - halo, base[1] - halo, base[2] - halo];
  });
}

test('structured ring suppression never accepts a materially worse candidate', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const damaged = ringDamaged(width, height, alpha);
  const before = measureStructuredRingResidual(damaged, alpha);
  // This test intentionally isolates the ring pass. Consensus, shape-ghost and
  // center-seam finishing are covered by their own safety/integration tests.
  const result = applyStructuredResidualRingSuppression(damaged, alpha, {
    consensus: false,
    shapeGhost: false,
    centerSeam: false,
    totalThreshold: 0.10,
    lumaThreshold: 0.10,
    strength: 0.58
  });
  const after = measureStructuredRingResidual(result, alpha);

  assert.equal(result.structuredRing.attempted, true);
  assert.ok(result.structuredRing.candidatePixels >= 0);
  assert.equal(typeof result.structuredRing.salvageAttempted, 'boolean');
  assert.equal(typeof result.structuredRing.salvageAccepted, 'boolean');
  if (result.structuredRing.accepted) {
    assert.ok(after.score <= before.score * 1.003);
    assert.ok(result.structuredRing.correctedPixels > 0);
    assert.ok(['primary', 'micro-salvage'].includes(result.structuredRing.acceptedMode));
  } else {
    assert.equal(after.score, before.score);
    assert.equal(result.structuredRing.acceptedMode, 'none');
  }
});

test('micro-salvage candidate is accepted only when final residual stays safer than the incoming structured result', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const damaged = ringDamaged(width, height, alpha);
  const result = applyStructuredResidualRingSuppression(damaged, alpha, {
    consensus: false,
    shapeGhost: false,
    centerSeam: false,
    totalThreshold: 0.10,
    lumaThreshold: 0.10,
    strength: 0.72,
    salvageNearMissRatio: 1.20,
    salvageStrengthScale: 0.22
  });

  assert.equal(result.structuredRing.attempted, true);
  if (result.structuredRing.salvageAttempted) {
    assert.ok(result.structuredRing.salvageCandidateAfter);
    assert.ok(result.structuredRing.salvageCandidatePixels >= 0);
    if (result.structuredRing.salvageAccepted) {
      assert.equal(result.structuredRing.acceptedMode, 'micro-salvage');
      assert.ok(result.structuredRing.after.total <= result.structuredRing.before.total * 0.998 + 1e-9);
      assert.ok(result.structuredRing.after.luma <= result.structuredRing.before.luma * 1.002 + 1e-9);
    }
  }
});

test('low-residual structured region skips the suppression pass', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const clean = image(width, height, (x, y) => [82 + x, 104 + Math.floor(y * 0.7), 142 + ((x + y) % 3)]);
  const result = applyStructuredResidualRingSuppression(clean, alpha, {
    consensus: false,
    shapeGhost: false,
    centerSeam: false,
    totalThreshold: 999,
    lumaThreshold: 999
  });
  assert.equal(result.structuredRing.attempted, false);
  assert.equal(result.structuredRing.accepted, false);
  assert.equal(result.structuredRing.salvageAttempted, false);
});

test('smooth-rebuild path does not run structured ring suppression', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const smooth = image(width, height, (x, y) => [45 + x * 2, 105 + Math.floor(y * 0.4), 185 + Math.floor(x * 0.6)]);
  const result = applyDualRingLumaFinish(smooth, alpha, {
    strength: 0.56,
    smoothBackground: true,
    structuredRing: true
  });
  if (result.smoothBackground?.mode === 'smooth-rebuild' || result.smoothBackground?.mode === 'empty-hard-rebuild') {
    assert.equal(result.structuredRing?.attempted, false);
  } else {
    assert.equal(result.structuredRing?.enabled, true);
  }
});

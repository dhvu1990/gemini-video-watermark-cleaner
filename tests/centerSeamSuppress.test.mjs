import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCenterSeamSuppression, measureCenterSeamResidual } from '../src/video/centerSeamSuppress.js';

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
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
      if (d <= 13) alpha[y * width + x] = Math.max(0.055, 0.66 * (1 - d / 16));
      else if (d <= 15) alpha[y * width + x] = 0.028 * (16 - d);
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

test('center seam suppression reduces an artificial watermark-axis seam without broad blur', () => {
  const width = 64, height = 64;
  const alpha = softDiamondAlpha(width, height);
  const cx = Math.round((width - 1) / 2);
  const clean = image(width, height, (x, y) => [178 + Math.floor(x * 0.35), 104 + Math.floor(y * 0.28), 72 + Math.floor((x + y) * 0.16)]);
  const damaged = image(width, height, (x, y) => {
    const p = y * width + x;
    const i = p * 4;
    const a = alpha[p];
    const seam = a > 0.055 && Math.abs(x - cx) <= 2 ? 15 : 0;
    return [clean.data[i] - seam, clean.data[i + 1] - seam, clean.data[i + 2] - seam];
  });

  const before = measureCenterSeamResidual(damaged, alpha);
  const result = applyCenterSeamSuppression(damaged, alpha, { strength: 0.62, minScore: 0.30 });
  const info = result.centerSeam;
  assert.ok(before.samples >= 6);
  assert.equal(info.attempted, true);
  assert.ok(info.candidateCorrectedPixels > 0);
  assert.ok(info.candidateAfter.score < info.before.score);
  if (info.accepted) {
    assert.ok(info.after.score <= info.before.score * 0.992 + 1e-9);
    assert.ok(meanDelta(result, damaged) > 0);
    assert.ok(info.meanAbsLumaDelta <= 14 + 1e-9);
  } else {
    assert.equal(meanDelta(result, damaged), 0);
  }
});

test('center seam guard resists a persistent real vertical scene line crossing the watermark area', () => {
  const width = 64, height = 64;
  const alpha = softDiamondAlpha(width, height);
  const cx = Math.round((width - 1) / 2);
  const source = image(width, height, (x, y) => {
    const base = 112 + Math.floor(y * 0.35);
    const line = Math.abs(x - cx) <= 1 ? -32 : 0;
    return [base + 24 + line, base + 8 + line, base + line];
  });

  const result = applyCenterSeamSuppression(source, alpha, { strength: 0.70, minScore: 0.20 });
  const info = result.centerSeam;
  assert.ok((info.before?.guardedSamples || 0) > 0 || (info.guardedPixels || 0) > 0);
  if (info.accepted) {
    assert.ok(info.after.score < info.before.score);
    assert.ok(info.outerAfter.total <= info.outerBefore.total * 1.005 + 1e-9);
    assert.ok(meanDelta(result, source) < 1.0);
  } else {
    assert.equal(meanDelta(result, source), 0);
  }
});

test('structured finisher exposes center seam diagnostics', async () => {
  const { applyStructuredResidualRingSuppression } = await import('../src/video/structuredRingSuppress.js');
  const width = 56, height = 56;
  const alpha = softDiamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const base = [96 + Math.floor(x * 0.7), 108 + Math.floor(y * 0.45), 122 + Math.floor((x + y) * 0.25)];
    const a = alpha[y * width + x];
    const seam = a > 0.055 && Math.abs(x - Math.round((width - 1) / 2)) <= 1 ? -12 : 0;
    return [base[0] + seam, base[1] + seam, base[2] + seam];
  });
  const result = applyStructuredResidualRingSuppression(source, alpha, {
    consensus: false,
    shapeGhost: false,
    totalThreshold: 999,
    lumaThreshold: 999,
    centerSeamOptions: { minScore: 0.20, strength: 0.62 }
  });
  assert.ok(result.structuredRing.centerSeam);
  assert.equal(typeof result.structuredRing.centerSeam.accepted, 'boolean');
});

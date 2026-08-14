import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPaddedTextureRepair,
  applyTemporalDonorRepair,
  buildHybridRepairMask,
  embedAlphaMap,
  estimateTemporalShift
} from '../src/video/textureRepair.js';

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

function mae(a, b, mask = null) {
  let sum = 0, count = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) { sum += Math.abs(a.data[i + c] - b.data[i + c]); count++; }
  }
  return count ? sum / count : 0;
}

function hybridAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const radius = dx + dy;
      if (radius <= 3) alpha[y * width + x] = 0.58;
      else if (radius <= 6) alpha[y * width + x] = 0.16;
      else if (radius <= 8) alpha[y * width + x] = 0.045;
    }
  }
  return alpha;
}

test('padded texture repair pulls a dark edge footprint toward surrounding background without flattening the core', () => {
  const width = 40, height = 40;
  const original = image(width, height, (x, y) => [80 + x, 100 + Math.floor(y / 2), 125 + Math.floor(x / 3)]);
  const alpha = hybridAlpha(width, height);
  const damaged = image(width, height, (x, y) => {
    const i = (y * width + x) * 4;
    const a = alpha[y * width + x];
    const damage = a > 0 && a < 0.30 ? 36 : (a >= 0.30 ? 8 : 0);
    return [original.data[i] - damage, original.data[i + 1] - damage, original.data[i + 2] - damage];
  });
  const repaired = applyPaddedTextureRepair(damaged, alpha, 0.8);
  const masks = buildHybridRepairMask(alpha, width, height);
  const edgeMask = masks.edge.map((v) => v > 0.35);
  const coreMask = masks.core.map((v) => v > 0.55);
  assert.ok(mae(repaired, original, edgeMask) < mae(damaged, original, edgeMask));
  assert.ok(mae(repaired, damaged, coreMask) < 2.5);
});

test('hybrid repair mask separates high-alpha core from edge ring', () => {
  const width = 25, height = 25;
  const alpha = hybridAlpha(width, height);
  const mask = buildHybridRepairMask(alpha, width, height);
  const center = 12 * width + 12;
  const edge = 12 * width + 18;
  assert.ok(mask.core[center] > 0.7);
  assert.ok(mask.edge[center] < 0.25);
  assert.ok(mask.edge[edge] > mask.core[edge]);
});

test('temporal shift detects translated clean border texture', () => {
  const width = 36, height = 36;
  const previous = image(width, height, (x, y) => [(x * 9 + y * 3) % 220, (x * 4 + y * 7) % 220, (x * 5 + y * 5) % 220]);
  const current = image(width, height, (x, y) => {
    const sx = Math.min(width - 1, Math.max(0, x + 3));
    const sy = Math.min(height - 1, Math.max(0, y - 2));
    const i = (sy * width + sx) * 4;
    return [previous.data[i], previous.data[i + 1], previous.data[i + 2]];
  });
  const alpha = new Float32Array(width * height);
  for (let y = 12; y < 24; y++) for (let x = 12; x < 24; x++) alpha[y * width + x] = 0.3;
  const shift = estimateTemporalShift(current, previous, alpha, 5);
  assert.equal(shift.dx, 3);
  assert.equal(shift.dy, -2);
  assert.ok(shift.improvement > 0.2);
});

test('temporal donor skips static frames where the donor is still watermarked', () => {
  const width = 32, height = 32;
  const alphaInner = new Float32Array(12 * 12).fill(0.3);
  const alpha = embedAlphaMap(alphaInner, 12, 12, width, height, 10, 10);
  const current = image(width, height, () => [90, 110, 130]);
  const processed = image(width, height, () => [70, 90, 110]);
  const repaired = applyTemporalDonorRepair(processed, current, current, alpha, 0.8);
  assert.equal(mae(repaired, processed), 0);
});

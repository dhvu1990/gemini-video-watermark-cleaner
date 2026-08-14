import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMicroEdgeFinish, applyNormalEdgeBridge } from '../src/video/edgeBridge.js';
import { buildHybridRepairMask } from '../src/video/textureRepair.js';

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
      if (d <= 4) alpha[y * width + x] = 0.58;
      else if (d <= 6) alpha[y * width + x] = 0.22;
      else if (d <= 8) alpha[y * width + x] = 0.055;
    }
  }
  return alpha;
}

function mae(a, b, mask) {
  let sum = 0, count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) { sum += Math.abs(a.data[i + c] - b.data[i + c]); count++; }
  }
  return count ? sum / count : 0;
}

test('normal edge bridge reduces a dark diamond ring while preserving core detail', () => {
  const width = 41, height = 41;
  const alpha = diamondAlpha(width, height);
  const masks = buildHybridRepairMask(alpha, width, height);
  const clean = image(width, height, (x, y) => [70 + x * 2, 96 + y, 124 + Math.floor((x + y) / 3)]);
  const damaged = image(width, height, (x, y) => {
    const p = y * width + x;
    const i = p * 4;
    const edge = masks.edge[p] || 0;
    const core = masks.core[p] || 0;
    const ringDamage = edge > 0.28 ? 42 : 0;
    const coreDetail = core > 0.55 ? ((x + y) % 3) * 4 : 0;
    return [
      clean.data[i] - ringDamage + coreDetail,
      clean.data[i + 1] - ringDamage + coreDetail,
      clean.data[i + 2] - ringDamage + coreDetail
    ];
  });

  const repaired = applyNormalEdgeBridge(damaged, alpha, 1);
  const edgeMask = masks.edge.map((v) => v > 0.32);
  const coreMask = masks.core.map((v) => v > 0.55);
  assert.ok(repaired.edgeBridge.bridgedPixels > 0);
  assert.ok(repaired.edgeBridge.finishingPixels >= 0);
  assert.ok(mae(repaired, clean, edgeMask) < mae(damaged, clean, edgeMask));
  assert.ok(mae(repaired, damaged, coreMask) < 2.0);
});

test('micro edge finish improves a thin residual ring without flattening the core', () => {
  const width = 49, height = 49;
  const alpha = diamondAlpha(width, height);
  const masks = buildHybridRepairMask(alpha, width, height);
  const clean = image(width, height, (x, y) => [58 + x * 2, 88 + Math.floor(y * 1.2), 118 + ((x + y) % 5)]);
  const residual = image(width, height, (x, y) => {
    const p = y * width + x;
    const i = p * 4;
    const edge = masks.edge[p] || 0;
    const core = masks.core[p] || 0;
    const halo = edge > 0.34 && core < 0.45 ? 18 : 0;
    const texture = core > 0.55 ? ((x * 3 + y * 5) % 7) - 3 : 0;
    return [clean.data[i] - halo + texture, clean.data[i + 1] - halo + texture, clean.data[i + 2] - halo + texture];
  });

  const finished = applyMicroEdgeFinish(residual, alpha, 0.72);
  const edgeMask = masks.edge.map((v, p) => v > 0.34 && masks.core[p] < 0.45);
  const coreMask = masks.core.map((v) => v > 0.55);
  assert.ok(finished.edgeFinish.finishingPixels > 0);
  assert.ok(mae(finished, clean, edgeMask) < mae(residual, clean, edgeMask));
  assert.ok(mae(finished, residual, coreMask) < 0.75);
});

test('normal edge bridge backs off across a strong real structure', () => {
  const width = 41, height = 41;
  const alpha = diamondAlpha(width, height);
  const base = image(width, height, (x, y) => x < 20 ? [35, 45, 60] : [210, 220, 230]);
  const repaired = applyNormalEdgeBridge(base, alpha, 1);
  const centerLeft = (20 * width + 19) * 4;
  const centerRight = (20 * width + 21) * 4;
  assert.ok(Math.abs(repaired.data[centerLeft] - base.data[centerLeft]) < 18);
  assert.ok(Math.abs(repaired.data[centerRight] - base.data[centerRight]) < 18);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDualRingLumaFinish, buildDualRingMask, measureDualRingResidual } from '../src/video/dualRingFinish.js';

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

function mae(a, b, mask) {
  let sum = 0, count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) { sum += Math.abs(a.data[i + c] - b.data[i + c]); count++; }
  }
  return count ? sum / count : 0;
}

test('dual-ring finish reduces ring residual while preserving core detail', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const masks = buildDualRingMask(alpha, width, height);
  const clean = image(width, height, (x, y) => [58 + x * 2, 82 + Math.floor(y * 1.1), 118 + ((x + y) % 4)]);
  const damaged = image(width, height, (x, y) => {
    const p = y * width + x;
    const i = p * 4;
    const ring = Math.max(masks.inner[p] || 0, masks.outer[p] || 0);
    const core = masks.core[p] || 0;
    const halo = ring > 0.18 && core < 0.5 ? 14 : 0;
    const detail = core > 0.55 ? ((x * 5 + y * 3) % 5) - 2 : 0;
    return [clean.data[i] - halo + detail, clean.data[i + 1] - halo + detail, clean.data[i + 2] - halo + detail];
  });

  const before = measureDualRingResidual(damaged, alpha);
  const repaired = applyDualRingLumaFinish(damaged, alpha, { strength: 0.72 });
  const after = measureDualRingResidual(repaired, alpha);
  const ringMask = masks.inner.map((v, p) => Math.max(v, masks.outer[p]) > 0.18);
  const coreMask = masks.core.map((v) => v > 0.55);

  assert.ok(repaired.dualRingFinish.correctedPixels > 0);
  assert.ok(after.total < before.total);
  assert.ok(repaired.dualRingFinish.improvement > 0);
  assert.ok(mae(repaired, clean, ringMask) < mae(damaged, clean, ringMask));
  assert.ok(mae(repaired, damaged, coreMask) < 0.75);
});

test('corner mask emphasizes diamond tips without marking the center core', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const masks = buildDualRingMask(alpha, width, height);
  const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
  const center = cy * width + cx;
  const topTip = 16 * width + cx;
  const rightTip = cy * width + 34;
  assert.ok((masks.corner[topTip] || 0) > (masks.corner[center] || 0));
  assert.ok((masks.corner[rightTip] || 0) > (masks.corner[center] || 0));
  assert.ok((masks.core[center] || 0) > 0.4);
});

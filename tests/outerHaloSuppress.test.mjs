import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOuterHaloSuppression, measureOuterHaloResidual } from '../src/video/outerHaloSuppress.js';

function makeSmoothHaloCase(width = 64, height = 64, haloDelta = -7) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      alpha[p] = Math.max(0, 0.64 - d * 0.055);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const base = 104 + x * 0.32 + y * 0.18;
      let halo = 0;
      if (alpha[p] <= 0.012) {
        let nearSource = false;
        for (let dy = -2; dy <= 2 && !nearSource; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!dx && !dy) continue;
            const sx = x + dx, sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            if (Math.hypot(dx, dy) > 2.01) continue;
            if ((alpha[sy * width + sx] || 0) >= 0.025) {
              nearSource = true;
              break;
            }
          }
        }
        if (nearSource) halo = haloDelta;
      }
      const i = p * 4;
      data[i] = Math.round(base + halo + 18);
      data[i + 1] = Math.round(base + halo + 6);
      data[i + 2] = Math.round(base + halo - 9);
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha };
}

function makeCheckerboardCase(width = 64, height = 64) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      alpha[p] = Math.max(0, 0.64 - d * 0.055);
      const tile = ((Math.floor(x / 2) + Math.floor(y / 2)) % 2) ? 58 : 190;
      const i = p * 4;
      data[i] = tile + 20;
      data[i + 1] = tile;
      data[i + 2] = Math.max(0, tile - 18);
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha };
}

test('outer halo suppression reduces a thin dark halo just outside the alpha footprint', () => {
  const { image, alpha } = makeSmoothHaloCase();
  const before = measureOuterHaloResidual(image, alpha, {
    minScore: 0.3,
    minSamples: 6,
    referenceDisagreementMax: 18,
    tangentSpanMax: 20
  });
  const result = applyOuterHaloSuppression(image, alpha, {
    minScore: 0.3,
    minSamples: 6,
    minImprovement: 0.01,
    strength: 0.78,
    referenceDisagreementMax: 18,
    tangentSpanMax: 20
  });

  assert.ok(before.samples >= 6);
  assert.ok(before.score > 1);
  assert.equal(result.outerHalo.attempted, true);
  assert.equal(result.outerHalo.accepted, true);
  assert.ok(result.outerHalo.after.score < before.score);
  assert.ok(result.outerHalo.correctedPixels > 0);
  assert.notDeepEqual([...result.data], [...image.data]);
});

test('outer halo suppression backs off on a high-detail checkerboard scene', () => {
  const { image, alpha } = makeCheckerboardCase();
  const result = applyOuterHaloSuppression(image, alpha, {
    minScore: 0.2,
    minSamples: 6,
    referenceDisagreementMax: 12,
    tangentSpanMax: 14
  });

  assert.equal(result.outerHalo.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

test('outer halo suppression safely no-ops on invalid alpha geometry', () => {
  const { image } = makeSmoothHaloCase();
  const result = applyOuterHaloSuppression(image, new Float32Array(3));
  assert.equal(result.outerHalo.enabled, false);
  assert.equal(result.outerHalo.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

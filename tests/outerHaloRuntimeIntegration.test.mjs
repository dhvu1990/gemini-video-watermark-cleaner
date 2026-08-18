import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredResidualRingSuppression } from '../src/video/structuredRingSuppress.js';

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

const earlierFinishersOff = {
  consensus: false,
  shapeGhost: false,
  centerSeam: false,
  localToneMatch: false,
  totalThreshold: 999,
  lumaThreshold: 999
};

test('structured runtime runs guarded outer halo after local-tone stage', () => {
  const { image, alpha } = makeSmoothHaloCase();
  const result = applyStructuredResidualRingSuppression(image, alpha, {
    ...earlierFinishersOff,
    outerHalo: true,
    outerHaloOptions: {
      minScore: 0.3,
      minSamples: 6,
      minImprovement: 0.01,
      strength: 0.78,
      referenceDisagreementMax: 18,
      tangentSpanMax: 20
    }
  });

  assert.equal(result.structuredRing.localToneMatch.enabled, false);
  assert.equal(result.structuredRing.outerHalo.enabled, true);
  assert.equal(result.structuredRing.outerHalo.attempted, true);
  assert.equal(result.structuredRing.outerHalo.accepted, true);
  assert.ok(result.structuredRing.outerHalo.correctedPixels > 0);
  assert.match(result.structuredRing.acceptedMode, /outer-halo/);
  assert.notDeepEqual([...result.data], [...image.data]);
});

test('structured runtime preserves explicit outer halo opt-out', () => {
  const { image, alpha } = makeSmoothHaloCase();
  const result = applyStructuredResidualRingSuppression(image, alpha, {
    ...earlierFinishersOff,
    outerHalo: false
  });

  assert.equal(result.structuredRing.outerHalo.enabled, false);
  assert.equal(result.structuredRing.outerHalo.accepted, false);
  assert.ok(!result.structuredRing.acceptedMode.includes('outer-halo'));
});

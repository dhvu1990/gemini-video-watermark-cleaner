import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredResidualRingSuppression } from '../src/video/structuredRingSuppress.js';

function makeCase(width = 64, height = 64, offset = 7) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      const a = Math.max(0, 0.64 - d * 0.055);
      alpha[p] = a;
      const base = 92 + x * 0.48 + y * 0.22;
      const lift = a >= 0.07 && a <= 0.68 ? offset : 0;
      const i = p * 4;
      data[i] = Math.round(base + lift + 22);
      data[i + 1] = Math.round(base + lift + 8);
      data[i + 2] = Math.round(base + lift - 10);
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha };
}

test('structured cleanup exposes guarded local-tone diagnostics after center-seam stage', () => {
  const { image, alpha } = makeCase();
  const result = applyStructuredResidualRingSuppression(image, alpha, {
    consensus: false,
    shapeGhost: false,
    centerSeam: false,
    totalThreshold: 999,
    lumaThreshold: 999,
    localToneMatch: true,
    localToneOptions: {
      minScore: 0.4,
      minSamples: 8,
      minReferenceSamples: 12,
      minImprovement: 0.01
    }
  });

  assert.equal(result.structuredRing.attempted, false);
  assert.equal(result.structuredRing.localToneMatch.enabled, true);
  assert.ok(result.structuredRing.localToneMatch.before);
  if (result.structuredRing.localToneMatch.accepted) {
    assert.ok(result.structuredRing.acceptedMode.includes('local-tone'));
  } else {
    assert.ok(!result.structuredRing.acceptedMode.includes('local-tone'));
  }
});

test('structured cleanup preserves explicit local-tone opt-out', () => {
  const { image, alpha } = makeCase();
  const result = applyStructuredResidualRingSuppression(image, alpha, {
    consensus: false,
    shapeGhost: false,
    centerSeam: false,
    totalThreshold: 999,
    lumaThreshold: 999,
    localToneMatch: false
  });

  assert.equal(result.structuredRing.localToneMatch.enabled, false);
  assert.equal(result.structuredRing.localToneMatch.accepted, false);
  assert.ok(!result.structuredRing.acceptedMode.includes('local-tone'));
});

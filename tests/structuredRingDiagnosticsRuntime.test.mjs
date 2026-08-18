import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDualRingLumaFinish } from '../src/video/dualRingFinish.js';

function makeImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 72 + x;
      data[i + 1] = 88 + Math.floor(y * 0.7);
      data[i + 2] = 118 + ((x + y) % 7);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function makeDiamondAlpha(width, height) {
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

test('dual-ring runtime exposes normalized structured-ring diagnostics without changing the structured result contract', () => {
  const width = 51;
  const height = 51;
  const image = makeImage(width, height);
  const alpha = makeDiamondAlpha(width, height);

  const result = applyDualRingLumaFinish(image, alpha, {
    strength: 0.56,
    smoothBackground: false,
    structuredRing: true,
    structuredRingTotalThreshold: 999,
    structuredRingLumaThreshold: 999
  });

  assert.ok(result.structuredRing);
  assert.ok(result.structuredRingDiagnostics);
  assert.equal(result.dualRingFinish.structuredRingDiagnostics, result.structuredRingDiagnostics);
  assert.equal(result.smoothBackground.structuredRingDiagnostics, result.structuredRingDiagnostics);
  assert.equal(result.structuredRingDiagnostics.enabled, true);
  assert.equal(result.structuredRingDiagnostics.attempted, result.structuredRing.attempted);
  assert.equal(result.structuredRingDiagnostics.accepted, result.structuredRing.accepted);
  assert.equal(result.structuredRingDiagnostics.alignedSampleCount, result.structuredRing.alignedBefore.samples);
  assert.ok(result.structuredRingDiagnostics.alignedSampleDensity >= 0);
  assert.ok(result.structuredRingDiagnostics.alignedSampleDensity <= 1);
});

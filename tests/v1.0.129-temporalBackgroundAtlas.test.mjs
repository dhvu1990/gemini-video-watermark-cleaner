import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBackgroundAtlas,
  buildBackgroundAtlas,
  summarizeAtlas
} from '../src/video/multiFrameRepair.js';

function alphaSquare(width, height, x0 = 18, y0 = 18, size = 12) {
  const alpha = new Float32Array(width * height);
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) alpha[y * width + x] = 0.34;
  }
  return alpha;
}

function sceneValue(x, y) {
  const xx = x + 80;
  const yy = y + 70;
  return 34 + ((xx * 13 + yy * 17 + ((xx * yy) % 29) * 7) % 180);
}

function frame(width, height, shiftX, shiftY, alpha, watermark = true) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const idx = p * 4;
      const value = sceneValue(x - shiftX, y - shiftY);
      data[idx] = value;
      data[idx + 1] = Math.min(255, value + 9);
      data[idx + 2] = Math.max(0, value - 11);
      data[idx + 3] = 255;
      if (watermark && (alpha[p] || 0) > 0.008) {
        data[idx] = 238;
        data[idx + 1] = 238;
        data[idx + 2] = 238;
      }
    }
  }
  return { width, height, data };
}

function channelError(image, reference, p) {
  const idx = p * 4;
  return (
    Math.abs(image.data[idx] - reference.data[idx])
    + Math.abs(image.data[idx + 1] - reference.data[idx + 1])
    + Math.abs(image.data[idx + 2] - reference.data[idx + 2])
  ) / 3;
}

test('v1.0.129 motion-aligned clean exposure reconstructs the high-alpha core from real temporal pixels', () => {
  const width = 48;
  const height = 48;
  const alpha = alphaSquare(width, height);
  const cleanReference = frame(width, height, 0, 0, alpha, false);
  const current = frame(width, height, 0, 0, alpha, true);
  const history = [
    frame(width, height, 13, 0, alpha, true),
    frame(width, height, -13, 0, alpha, true),
    frame(width, height, 0, 13, alpha, true),
    frame(width, height, 0, -13, alpha, true)
  ];

  const atlas = buildBackgroundAtlas(current, history, alpha, {
    maxHistory: 4,
    maxShift: 14,
    temporalExposureMaxShift: 14,
    minImprovement: 0.03,
    allowMaskedDonors: true
  });
  const summary = summarizeAtlas(atlas);
  const center = 24 * width + 24;

  assert.ok(atlas.observedSupport[center] >= 2, `support=${atlas.observedSupport[center]}`);
  assert.ok(atlas.observedConfidence[center] >= 0.26, `confidence=${atlas.observedConfidence[center]}`);
  assert.ok(summary.observedCoreSupportedPixels > 0);
  assert.equal(summary.temporalObservedAtlas, true);

  const processed = frame(width, height, 0, 0, alpha, false);
  for (let p = 0; p < alpha.length; p++) {
    if ((alpha[p] || 0) < 0.12) continue;
    const idx = p * 4;
    processed.data[idx] = 28;
    processed.data[idx + 1] = 42;
    processed.data[idx + 2] = 58;
  }
  const before = channelError(processed, cleanReference, center);
  const repaired = applyBackgroundAtlas(processed, alpha, atlas, 1);
  const after = channelError(repaired, cleanReference, center);

  assert.ok(repaired.temporalBackgroundAtlas.observedCoreCorrectedPixels > 0);
  assert.ok(after < before * 0.72, `before=${before} after=${after}`);
});

test('v1.0.129 does not invent temporal core coverage when static donors never expose the hidden background', () => {
  const width = 48;
  const height = 48;
  const alpha = alphaSquare(width, height);
  const current = frame(width, height, 0, 0, alpha, true);
  const history = [
    frame(width, height, 0, 0, alpha, true),
    frame(width, height, 0, 0, alpha, true),
    frame(width, height, 0, 0, alpha, true)
  ];
  const atlas = buildBackgroundAtlas(current, history, alpha, {
    maxHistory: 3,
    maxShift: 14,
    temporalExposureMaxShift: 14,
    minImprovement: 0.03,
    allowMaskedDonors: true
  });
  const center = 24 * width + 24;

  assert.equal(atlas.observedSupport[center], 0);
  assert.equal(atlas.observedCoreSupportedPixels, 0);
});

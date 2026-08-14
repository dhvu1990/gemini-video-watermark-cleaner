import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBackgroundAtlas,
  buildBackgroundAtlas,
  estimateAtlasShift,
  summarizeAtlas
} from '../src/video/multiFrameRepair.js';

function makeAlpha(width, height, x0 = 10, y0 = 10, size = 8) {
  const alpha = new Float32Array(width * height);
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) alpha[y * width + x] = 0.3;
  }
  return alpha;
}

function pattern(x, y) {
  return (x * 17 + y * 11 + ((x * y) % 19) * 5) % 220 + 18;
}

function makeFrame(width, height, shiftX = 0, shiftY = 0, watermark = false, alpha = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const value = pattern(x - shiftX + 40, y - shiftY + 40);
      data[idx] = value;
      data[idx + 1] = Math.min(255, value + 7);
      data[idx + 2] = Math.max(0, value - 9);
      data[idx + 3] = 255;
      if (watermark && alpha?.[y * width + x] > 0.01) {
        data[idx] = 245;
        data[idx + 1] = 245;
        data[idx + 2] = 245;
      }
    }
  }
  return { width, height, data };
}

test('atlas shift estimates translated background from clean border pixels', () => {
  const width = 32, height = 32;
  const alpha = makeAlpha(width, height);
  const current = makeFrame(width, height, 0, 0, true, alpha);
  const donor = makeFrame(width, height, 3, -2, true, alpha);
  const shift = estimateAtlasShift(current, donor, alpha, 5);
  assert.equal(shift.dx, 3);
  assert.equal(shift.dy, -2);
  assert.ok(shift.improvement > 0.4);
});

test('raw atlas only accepts donors that expose clean pixels outside the fixed mask', () => {
  const width = 32, height = 32;
  const alpha = makeAlpha(width, height, 12, 12, 6);
  const current = makeFrame(width, height, 0, 0, true, alpha);
  const history = [
    makeFrame(width, height, 5, 0, true, alpha),
    makeFrame(width, height, -5, 0, true, alpha),
    makeFrame(width, height, 0, 5, true, alpha)
  ];
  const atlas = buildBackgroundAtlas(current, history, alpha, { maxShift: 6, minImprovement: 0.04 });
  const summary = summarizeAtlas(atlas);
  assert.ok(summary.donorCount >= 2);
  assert.ok(summary.supportedPixels > 0);
  assert.equal(summary.allowMaskedDonors, false);
});

test('cleaned donor consensus can reconstruct pixels inside the watermark footprint', () => {
  const width = 32, height = 32;
  const alpha = makeAlpha(width, height, 10, 10, 10);
  const current = makeFrame(width, height, 0, 0, true, alpha);
  const history = [
    makeFrame(width, height, 3, 0, false, alpha),
    makeFrame(width, height, -3, 0, false, alpha),
    makeFrame(width, height, 0, 3, false, alpha),
    makeFrame(width, height, 0, -3, false, alpha)
  ];
  const atlas = buildBackgroundAtlas(current, history, alpha, {
    maxShift: 5,
    minImprovement: 0.04,
    allowMaskedDonors: true
  });
  const summary = summarizeAtlas(atlas);
  assert.ok(summary.donorCount >= 3);
  assert.ok(summary.supportedPixels > 0);

  const processed = makeFrame(width, height, 0, 0, false, alpha);
  for (let y = 10; y < 20; y++) {
    for (let x = 10; x < 20; x++) {
      const idx = (y * width + x) * 4;
      processed.data[idx] = 20;
      processed.data[idx + 1] = 30;
      processed.data[idx + 2] = 50;
    }
  }
  const before = processed.data[(15 * width + 15) * 4];
  const repaired = applyBackgroundAtlas(processed, alpha, atlas, 1);
  const after = repaired.data[(15 * width + 15) * 4];
  assert.notEqual(after, before);
});

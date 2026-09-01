import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyInternalResidualRescue, measureInternalResidual } from '../src/video/internalResidualRescue.js';

function flatImage(width = 48, height = 48, value = 90) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }
  return { width, height, data };
}

function diamondAlpha(width, height, alpha = 0.44) {
  const map = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const rx = width * 0.24;
  const ry = height * 0.30;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) / rx + Math.abs(y - cy) / ry;
      if (d <= 1) map[y * width + x] = alpha;
    }
  }
  return map;
}

test('internal residual rescue is a no-op on a clean flat field', () => {
  const image = flatImage();
  const alphaMap = diamondAlpha(image.width, image.height);
  const before = measureInternalResidual(image, alphaMap);
  const result = applyInternalResidualRescue(image, alphaMap);
  assert.equal(before.highResidualPixels, 0);
  assert.equal(result.internalResidualRescue.attempted, false);
  assert.equal(result.internalResidualRescue.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

test('internal residual rescue can reduce an isolated bright watermark highlight', () => {
  const image = flatImage();
  const alphaMap = diamondAlpha(image.width, image.height);
  const cx = Math.floor(image.width / 2);
  const cy = Math.floor(image.height / 2) - 5;
  const p = (cy * image.width + cx) * 4;
  image.data[p] = 170;
  image.data[p + 1] = 170;
  image.data[p + 2] = 170;

  const result = applyInternalResidualRescue(image, alphaMap, {
    minHighlightPixels: 1,
    minHighlightDensity: 0,
    minHighlightResidual: 8,
    highlightResidual: 8,
    maxLumaDelta: 16,
    maxBlend: 0.36,
    strength: 0.42
  });

  assert.equal(result.internalResidualRescue.attempted, true);
  assert.equal(result.internalResidualRescue.accepted, true);
  assert.ok(result.internalResidualRescue.correctedPixels > 0);
  assert.ok(result.data[p] < image.data[p]);
  assert.ok(result.internalResidualRescue.after.maxResidual < result.internalResidualRescue.before.maxResidual);
});

test('internal rescue keeps bounded scene override and global rollback checks', () => {
  const source = readFileSync(new URL('../src/video/internalResidualRescue.js', import.meta.url), 'utf8');
  assert.match(source, /highlightHardSceneGuard \?\? 0\.86/);
  assert.match(source, /maxBlend \?\? 0\.30/);
  assert.match(source, /maxLumaDelta \?\? 12/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.004 \+ 0\.035/);
  assert.match(source, /afterGlobal\.luma <= beforeGlobal\.luma \* 1\.006 \+ 0\.04/);
  assert.match(source, /afterGlobal\.chroma <= beforeGlobal\.chroma \* 1\.006 \+ 0\.30/);
});

test('structured rescue runs internal residual cleanup after contour cleanup', () => {
  const source = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');
  const contourIndex = source.indexOf('applyContourMicroInterpolation');
  const internalIndex = source.lastIndexOf('applyInternalResidualRescue');
  assert.ok(contourIndex >= 0);
  assert.ok(internalIndex > contourIndex);
  assert.match(source, /internalResidualAccepted/);
  assert.match(source, /internalResidualRescue/);
});

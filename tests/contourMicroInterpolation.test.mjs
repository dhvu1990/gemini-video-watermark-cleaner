import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyContourMicroInterpolation } from '../src/video/contourMicroInterpolation.js';

function flatImage(width = 24, height = 24, value = 90) {
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

test('micro interpolation is a no-op when no contour residual is present', () => {
  const image = flatImage();
  const alphaMap = new Float32Array(image.width * image.height);
  const result = applyContourMicroInterpolation(image, alphaMap);
  assert.equal(result.contourMicroInterpolation.eligible, false);
  assert.equal(result.contourMicroInterpolation.attempted, false);
  assert.equal(result.contourMicroInterpolation.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

test('micro interpolation uses two-sided contour-normal anchors and local scene protection', () => {
  const source = readFileSync(new URL('../src/video/contourMicroInterpolation.js', import.meta.url), 'utf8');
  assert.match(source, /alphaGradient\(alphaMap/);
  assert.match(source, /cleanAnchor\(image, alphaMap, x, y, nx, ny, -1/);
  assert.match(source, /cleanAnchor\(image, alphaMap, x, y, nx, ny, 1/);
  assert.match(source, /sceneEdgeProtectionAt\(image, alphaMap, x, y/);
  assert.match(source, /hardSceneGuard/);
});

test('micro interpolation keeps conservative local and global rollback checks', () => {
  const source = readFileSync(new URL('../src/video/contourMicroInterpolation.js', import.meta.url), 'utf8');
  assert.match(source, /maxBlend \?\? 0\.30/);
  assert.match(source, /maxLumaDelta \?\? 7/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.004 \+ 0\.03/);
  assert.match(source, /afterGlobal\.luma <= beforeGlobal\.luma \* 1\.005 \+ 0\.03/);
  assert.match(source, /afterGlobal\.chroma <= beforeGlobal\.chroma \* 1\.004 \+ 0\.25/);
});

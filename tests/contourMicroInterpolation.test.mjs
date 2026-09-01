import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyContourMicroInterpolation, buildContourSafetyBand } from '../src/video/contourMicroInterpolation.js';

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

test('contour safety band expands beyond faint alpha and boosts four tips', () => {
  const width = 72, height = 72;
  const alphaMap = new Float32Array(width * height);
  for (let y = 18; y <= 53; y++) {
    const half = Math.max(1, Math.round((18 - Math.abs(y - 35.5)) * 0.85));
    for (let x = 36 - half; x <= 36 + half; x++) alphaMap[y * width + x] = 0.08;
  }
  const band = buildContourSafetyBand(alphaMap, width, height);
  assert.ok(band.baseRadius >= 3);
  assert.ok(band.tipExtraRadius >= 1);
  assert.ok(band.pixels > 0);
  assert.ok(band.weight[15 * width + 36] > 0, 'top tip receives an expanded safety band');
  assert.ok(band.guardAlpha[15 * width + 36] > 0, 'expanded band participates in scene protection and anchor exclusion');
});

test('micro interpolation uses safety-band-aware anchors and local scene protection', () => {
  const source = readFileSync(new URL('../src/video/contourMicroInterpolation.js', import.meta.url), 'utf8');
  assert.match(source, /buildContourSafetyBand/);
  assert.match(source, /alphaGradient\(safety\.guardAlpha/);
  assert.match(source, /cleanAnchor\(image, guideAlpha/);
  assert.match(source, /sceneEdgeProtectionAt\(image, safety\.guardAlpha, x, y/);
  assert.match(source, /safetyBandCorrectedPixels/);
  assert.match(source, /maxRescuePasses/);
});

test('micro interpolation keeps conservative local and global rollback checks', () => {
  const source = readFileSync(new URL('../src/video/contourMicroInterpolation.js', import.meta.url), 'utf8');
  assert.match(source, /maxBlend \?\? 0\.30/);
  assert.match(source, /maxLumaDelta \?\? 7/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.004 \+ 0\.03/);
  assert.match(source, /afterGlobal\.luma <= beforeGlobal\.luma \* 1\.005 \+ 0\.03/);
  assert.match(source, /afterGlobal\.chroma <= beforeGlobal\.chroma \* 1\.004 \+ 0\.25/);
});

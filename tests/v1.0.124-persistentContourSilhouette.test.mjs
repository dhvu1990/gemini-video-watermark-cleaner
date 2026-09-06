import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPersistentContourSilhouetteDissolve } from '../src/video/persistentContourSilhouetteDissolve.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function syntheticContourScene({ width = 72, height = 72, residual = 14 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const radius = 22;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const diamond = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
      const a = clamp((1.08 - diamond) * 0.64, 0, 0.64);
      alpha[p] = a;
      const base = 92 + x * 0.34 + y * 0.18;
      const contour = a >= 0.012 && a <= 0.26 ? Math.sin(Math.PI * clamp((a - 0.012) / 0.248, 0, 1)) : 0;
      const value = clamp(base - contour * residual, 0, 255);
      const i = p * 4;
      data[i] = value;
      data[i + 1] = value + 4;
      data[i + 2] = value + 7;
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha };
}

test('v1.0.124 dissolves persistent watermark-shaped contour using local contour acceptance', () => {
  const { image, alpha } = syntheticContourScene();
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, {
    detectionConfidence: 0.91,
    minScore: 0.30,
    minDensity: 0.015,
    minSamples: 6,
    minSectors: 2,
    minOutlineImprovement: 0.003,
    maxOutlineRatio: 0.998,
    minLocalImprovement: 0.04,
    maxPasses: 2
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, true);
  assert.equal(diag.accepted, true);
  assert.equal(diag.acceptanceMode, 'local-contour-metric');
  assert.ok(diag.correctedPixels > 0);
  assert.ok(diag.afterOutline.score < diag.beforeOutline.score);
});

test('v1.0.124 blocks persistent contour rescue below 40 percent detection confidence', () => {
  const { image, alpha } = syntheticContourScene();
  const before = new Uint8ClampedArray(image.data);
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, {
    detectionConfidence: 0.26,
    minScore: 0.10,
    minDensity: 0.005,
    minSamples: 4
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, false);
  assert.equal(diag.accepted, false);
  assert.equal(diag.reason, 'low-detection-confidence');
  assert.equal(diag.confidencePolicy.mode, 'low');
  assert.deepEqual(result.data, before);
});

test('runtime wiring keeps the v1.0.124 contour pass and detection confidence visible in source', () => {
  const rescueSource = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');
  const engineSource = readFileSync(new URL('../src/video/engine.js', import.meta.url), 'utf8');
  assert.match(rescueSource, /applyPersistentContourSilhouetteDissolve/);
  assert.match(rescueSource, /persistentContourSilhouetteDissolve/);
  assert.match(engineSource, /detectionConfidence/);
});

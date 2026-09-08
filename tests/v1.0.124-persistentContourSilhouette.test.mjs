import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPersistentContourSilhouetteDissolve } from '../src/video/persistentContourSilhouetteDissolve.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function syntheticContourScene({ width = 72, height = 72, residual = 24 } = {}) {
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
    minScore: 0.20,
    minDensity: 0.010,
    minSamples: 6,
    minSectors: 2,
    minCorrectedPixels: 1,
    minOutlineImprovement: -1,
    maxOutlineRatio: 10,
    minLocalImprovement: 0,
    maxMeanBlend: 1,
    residualSoft: 0.10,
    residualHard: 0.40,
    donorSpreadSoft: 20,
    donorSpreadHard: 60,
    minAlphaGradient: 0.001,
    minAnchors: 2,
    maxRadius: 14,
    hardSceneGuard: 1.1,
    maxPasses: 1
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, true);
  assert.equal(diag.accepted, true);
  assert.equal(diag.acceptanceMode, 'local-contour-metric');
  assert.ok(diag.correctedPixels > 0);
  assert.ok(diag.localImprovement > 0);
  assert.equal(diag.globalSafe, true);
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
  const rescueSource = readFileSync(new URL('../src/video/structuredSmoothRescueCore.js', import.meta.url), 'utf8');
  const engineSource = readFileSync(new URL('../src/video/engine.js', import.meta.url), 'utf8');
  assert.match(rescueSource, /applyPersistentContourSilhouetteDissolve/);
  assert.match(rescueSource, /persistentContourSilhouetteDissolve/);
  assert.match(engineSource, /detectionConfidence/);
});

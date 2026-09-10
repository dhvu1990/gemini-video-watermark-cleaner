import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPersistentContourSilhouetteDissolve } from '../src/video/persistentContourSilhouetteDissolve.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function syntheticSmoothContourScene({ width = 80, height = 80, crossingLine = false } = {}) {
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
      const base = 118 + x * 0.10 + y * 0.07;
      const contour = a >= 0.012 && a <= 0.26
        ? Math.sin(Math.PI * clamp((a - 0.012) / 0.248, 0, 1)) * 13
        : 0;
      const line = crossingLine && Math.abs(y - Math.round(0.52 * x + 18)) <= 1 ? 42 : 0;
      const value = clamp(base - contour - line, 0, 255);
      const i = p * 4;
      data[i] = value;
      data[i + 1] = value + 3;
      data[i + 2] = value + 5;
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha };
}

const fallbackFixtureOptions = {
  detectionConfidence: 0.90,
  minScore: 0.10,
  minDensity: 0.004,
  minSamples: 6,
  minSectors: 2,
  minCorrectedPixels: 1,
  minOutlineImprovement: 0.99,
  maxOutlineRatio: 0.20,
  minLocalImprovement: 0.99,
  minExteriorCorrectedPixels: 1,
  minExteriorLocalImprovement: 0.99,
  maxExteriorOutlineRatio: 0.20,
  maxMeanBlend: 1,
  residualSoft: 0.10,
  residualHard: 0.45,
  donorSpreadSoft: 20,
  donorSpreadHard: 60,
  minAlphaGradient: 0.001,
  minAnchors: 2,
  maxRadius: 16,
  outerBandRadius: 3,
  outerBandScale: 0.90,
  hardSceneGuard: 0.72,
  maxPasses: 1,
  smoothFallbackMinCorrectedPixels: 1,
  smoothFallbackMinExteriorCorrectedPixels: 1,
  smoothFallbackMinLocalImprovement: 0,
  smoothFallbackMinExteriorLocalImprovement: 0,
  smoothFallbackMaxMeanBlend: 1,
  smoothFallbackMaxOutlineRatio: 10,
  smoothFallbackMaxTotalRatio: 10,
  smoothFallbackMaxLumaRatio: 10,
  smoothFallbackMaxChromaRatio: 10
};

test('v1.0.126 accepts locally useful contour cleanup on a smooth high-confidence scene when the strict aggregate gate rejects it', () => {
  const { image, alpha } = syntheticSmoothContourScene();
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, fallbackFixtureOptions);
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, true, JSON.stringify(diag));
  assert.equal(diag.accepted, true, JSON.stringify(diag));
  assert.equal(diag.acceptanceMode, 'smooth-scene-local-fallback', JSON.stringify(diag));
  assert.equal(diag.smoothSceneFallback?.accepted, true, JSON.stringify(diag));
  assert.ok(diag.correctedPixels > 0, JSON.stringify(diag));
  assert.ok(diag.fallbackPassesAccepted > 0, JSON.stringify(diag));
});

test('v1.0.126 does not use smooth-scene fallback across a protected crossing scene edge', () => {
  const { image, alpha } = syntheticSmoothContourScene({ crossingLine: true });
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, {
    ...fallbackFixtureOptions,
    smoothFallbackMaxSceneScore: 0.18,
    smoothFallbackMaxSceneDensity: 0.035,
    smoothFallbackMaxContinuityDensity: 0.020
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, true, JSON.stringify(diag));
  assert.equal(diag.smoothSceneFallback?.accepted, false, JSON.stringify(diag));
  assert.notEqual(diag.acceptanceMode, 'smooth-scene-local-fallback', JSON.stringify(diag));
});

test('v1.0.126 keeps the existing low-confidence block and never enters fallback', () => {
  const { image, alpha } = syntheticSmoothContourScene();
  const before = new Uint8ClampedArray(image.data);
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, {
    ...fallbackFixtureOptions,
    detectionConfidence: 0.26
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, false);
  assert.equal(diag.accepted, false);
  assert.equal(diag.reason, 'low-detection-confidence');
  assert.equal(diag.smoothSceneFallback?.accepted, false);
  assert.deepEqual(result.data, before);
});

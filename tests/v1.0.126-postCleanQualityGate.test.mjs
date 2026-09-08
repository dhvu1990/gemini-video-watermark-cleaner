import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPostCleanQualityGate } from '../src/video/postCleanQualityGate.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function lumaAt(image, p) {
  const i = p * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}

function syntheticSmoothScene({ width = 96, height = 96, artifact = true, crossingLine = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const target = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const radius = 22;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const diamond = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
      const a = clamp((1.08 - diamond) * 0.62, 0, 0.62);
      alpha[p] = a;
      const base = 108 + x * 0.24 + y * 0.13 + x * y * 0.0009;
      target[p] = base;
      let value = base;
      if (artifact && a > 0.004) {
        const contour = a < 0.26 ? 9 * Math.sin(Math.PI * clamp(a / 0.26, 0, 1)) : 0;
        value -= 17 + contour;
      }
      if (crossingLine && Math.abs(y - Math.round(cy)) <= 1 && x >= 8 && x < width - 8) value -= 44;
      const i = p * 4;
      data[i] = clamp(Math.round(value), 0, 255);
      data[i + 1] = clamp(Math.round(value + 4), 0, 255);
      data[i + 2] = clamp(Math.round(value + 7), 0, 255);
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha, target };
}

function roiError(image, alpha, target) {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 0.006) continue;
    sum += Math.abs(lumaAt(image, p) - (target[p] + 3.42));
    count++;
  }
  return count ? sum / count : 0;
}

const rescueOptions = {
  detectionConfidence: 0.90,
  supportAlpha: 0.006,
  donorInnerRadius: 4,
  donorOuterRadius: 13,
  maxDonorAlpha: 0.003,
  minDonorSamples: 40,
  maxModelMae: 4.5,
  maxRgbMae: 5.5,
  maxMeanGradient: 8,
  maxHighGradientDensity: 0.08,
  maxSceneEdgeScore: 0.24,
  minBeforeScore: 2.5,
  minModelMismatch: 2.0,
  minBoundaryMismatch: 1.8,
  strength: 0.88,
  exteriorStrength: 0.52,
  regrainStrength: 0.12,
  maxChannelDelta: 42,
  minQualityImprovement: 0.04,
  maxModelMismatchRatio: 0.99,
  maxBoundaryMismatchRatio: 1.00,
  maxContourResidualRatio: 1.10,
  minCorrectedPixels: 8
};

test('v1.0.126 selects annulus surface reconstruction for a smooth dark cleanup island', () => {
  const { image, alpha, target } = syntheticSmoothScene({ artifact: true });
  const before = roiError(image, alpha, target);
  const result = applyPostCleanQualityGate(image, alpha, rescueOptions);
  const diag = result.postCleanQualityGate;
  assert.equal(diag.attempted, true, JSON.stringify(diag));
  assert.equal(diag.accepted, true, JSON.stringify(diag));
  assert.equal(diag.selectedCandidate, 'annulus-surface-regrain');
  assert.ok(diag.correctedPixels > 0);
  assert.ok(diag.qualityImprovement > 0);
  assert.ok(roiError(result, alpha, target) < before, JSON.stringify(diag));
});

test('v1.0.126 leaves an already clean smooth region alone', () => {
  const { image, alpha } = syntheticSmoothScene({ artifact: false });
  const before = new Uint8ClampedArray(image.data);
  const result = applyPostCleanQualityGate(image, alpha, rescueOptions);
  const diag = result.postCleanQualityGate;
  assert.equal(diag.accepted, false, JSON.stringify(diag));
  assert.equal(diag.selectedCandidate, 'baseline');
  assert.deepEqual(result.data, before);
});

test('v1.0.126 refuses smooth reconstruction when a real scene edge crosses the watermark', () => {
  const { image, alpha } = syntheticSmoothScene({ artifact: true, crossingLine: true });
  const before = new Uint8ClampedArray(image.data);
  const result = applyPostCleanQualityGate(image, alpha, {
    ...rescueOptions,
    maxSceneEdgeScore: 0.12,
    sceneEdgeOptions: {
      minGradient: 3,
      fullGradient: 9,
      highScore: 0.20,
      mediumScore: 0.10,
      highDensity: 0.012,
      mediumDensity: 0.006,
      protectContinuityDensity: 0.004,
      protectMeanGradient: 4
    }
  });
  const diag = result.postCleanQualityGate;
  assert.equal(diag.accepted, false, JSON.stringify(diag));
  assert.equal(diag.selectedCandidate, 'baseline');
  assert.deepEqual(result.data, before);
  assert.ok(diag.sceneEdgeRisk?.protect || diag.reason === 'structured-or-unsafe-annulus', JSON.stringify(diag));
});

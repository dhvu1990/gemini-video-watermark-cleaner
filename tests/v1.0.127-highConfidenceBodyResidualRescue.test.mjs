import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyHighConfidenceBodyResidualRescue } from '../src/video/highConfidenceBodyResidualRescue.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function diamondAlpha(width = 72, height = 72) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      alpha[y * width + x] = d <= 11 ? 0.42 : (d <= 15 ? 0.18 : (d <= 18 ? 0.04 : 0));
    }
  }
  return alpha;
}

function makeBodyResidualScene({ crossingEdge = false } = {}) {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const a = alpha[p] || 0;
      const sceneStep = crossingEdge ? (x < width / 2 ? -55 : 55) : 0;
      const base = 112 + x * 0.08 + y * 0.05 + sceneStep;
      const ghost = a >= 0.075 ? 18 : 0;
      const value = clamp(base + ghost, 0, 255);
      const i = p * 4;
      data[i] = value;
      data[i + 1] = clamp(value + 3, 0, 255);
      data[i + 2] = clamp(value + 5, 0, 255);
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha };
}

function lumaAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}

const permissiveBodyOptions = {
  trigger: true,
  minDetectionConfidence: 0.65,
  minDirections: 2,
  minPairAgreement: 0.10,
  minConsensus: 0.10,
  minCorrectedPixels: 1,
  minLocalBeforeResidual: 0.10,
  minLocalImprovement: 0,
  minAcceptedConsensus: 0,
  maxAcceptedMeanBlend: 1,
  maxGuardedFraction: 1,
  maxOutlineRatio: 10,
  maxTotalRatio: 10,
  maxLumaRatio: 10,
  maxChromaRatio: 10,
  hardSceneGuard: 0.95,
  sceneEdgeOptions: { highScore: 2, mediumScore: 2 }
};

test('v1.0.127 removes broad high-confidence diamond body residual after contour cleanup', () => {
  const { image, alpha } = makeBodyResidualScene();
  const cx = Math.floor(image.width / 2);
  const cy = Math.floor(image.height / 2);
  const before = lumaAt(image, cx, cy);
  const result = applyHighConfidenceBodyResidualRescue(image, alpha, {
    ...permissiveBodyOptions,
    detectionConfidence: 0.91
  });
  const diagnostics = result.highConfidenceBodyResidualRescue;
  assert.equal(diagnostics.eligible, true, JSON.stringify(diagnostics));
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.correctedPixels > 0, JSON.stringify(diagnostics));
  assert.ok(diagnostics.localImprovement > 0, JSON.stringify(diagnostics));
  assert.ok(lumaAt(result, cx, cy) < before, `before=${before}, after=${lumaAt(result, cx, cy)}`);
});

test('v1.0.127 keeps the body rescue disabled for the medium-confidence class seen in the fresh batch', () => {
  const { image, alpha } = makeBodyResidualScene();
  const before = new Uint8ClampedArray(image.data);
  const result = applyHighConfidenceBodyResidualRescue(image, alpha, {
    ...permissiveBodyOptions,
    detectionConfidence: 0.54
  });
  const diagnostics = result.highConfidenceBodyResidualRescue;
  assert.equal(diagnostics.eligible, false, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, false, JSON.stringify(diagnostics));
  assert.equal(diagnostics.reason, 'confidence-gate');
  assert.deepEqual(result.data, before);
});

test('v1.0.127 blocks body reconstruction when a strong real scene edge crosses the watermark', () => {
  const { image, alpha } = makeBodyResidualScene({ crossingEdge: true });
  const before = new Uint8ClampedArray(image.data);
  const result = applyHighConfidenceBodyResidualRescue(image, alpha, {
    detectionConfidence: 0.91,
    trigger: true,
    maxSceneScore: 0,
    maxSceneDensity: 0,
    maxContinuityDensity: 0
  });
  const diagnostics = result.highConfidenceBodyResidualRescue;
  assert.equal(diagnostics.sceneGate.safe, false, JSON.stringify(diagnostics.sceneGate));
  assert.equal(diagnostics.eligible, false, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, false, JSON.stringify(diagnostics));
  assert.equal(diagnostics.reason, 'scene-risk-gate');
  assert.deepEqual(result.data, before);
});

test('v1.0.127 runtime wrapper runs body rescue only after the existing persistent contour core', () => {
  const wrapper = fs.readFileSync(
    new URL('../src/video/persistentContourSilhouetteDissolve.js', import.meta.url),
    'utf8'
  );
  // v1.0.130 deliberately inserts cleanupOptions between the observed detector
  // confidence and the contour core. Keep this wiring assertion structural
  // rather than requiring the old exact argument variable name.
  assert.match(wrapper, /applyPersistentContourCore\(image, alphaMap, (?:options|cleanupOptions)\)/);
  assert.match(wrapper, /applyHighConfidenceBodyResidualRescue/);
  assert.match(wrapper, /preBodyRemainingStrong/);
  assert.match(wrapper, /bodyResidualAccepted/);
});

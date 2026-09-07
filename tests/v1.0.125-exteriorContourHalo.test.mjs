import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPersistentContourSilhouetteDissolve } from '../src/video/persistentContourSilhouetteDissolve.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function lumaAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return 0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2];
}

function syntheticExteriorHaloScene({ width = 80, height = 80, line = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const ringMask = new Uint8Array(width * height);
  const lineMask = new Uint8Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const radius = 22;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const diamond = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
      const a = clamp((1.08 - diamond) * 0.64, 0, 0.64);
      alpha[p] = a;
      const base = 104 + x * 0.16 + y * 0.11;
      const innerContour = a >= 0.012 && a <= 0.26 ? Math.sin(Math.PI * clamp((a - 0.012) / 0.248, 0, 1)) * 7 : 0;
      const exterior = a < 0.006 && diamond >= 1.12 && diamond <= 1.18;
      const halo = exterior ? 19 : 0;
      const realLine = line && Math.abs(y - Math.round(cy)) <= 1 && x >= 7 && x < width - 7;
      ringMask[p] = exterior ? 1 : 0;
      lineMask[p] = realLine ? 1 : 0;
      const value = clamp(base - innerContour - halo - (realLine ? 34 : 0), 0, 255);
      const i = p * 4;
      data[i] = value;
      data[i + 1] = value + 3;
      data[i + 2] = value + 6;
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha, ringMask, lineMask };
}

function ringError(image, ringMask) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = y * image.width + x;
      if (!ringMask[p]) continue;
      const base = 104 + x * 0.16 + y * 0.11;
      sum += Math.abs(lumaAt(image, x, y) - (base + 2.58));
      count++;
    }
  }
  return count ? sum / count : 0;
}

const permissive = {
  minScore: 0.12,
  minDensity: 0.004,
  minSamples: 6,
  minSectors: 2,
  minCorrectedPixels: 1,
  minOutlineImprovement: -1,
  maxOutlineRatio: 10,
  minLocalImprovement: 0,
  maxMeanBlend: 1,
  minExteriorCorrectedPixels: 1,
  minExteriorLocalImprovement: 0,
  maxExteriorOutlineRatio: 10,
  residualSoft: 0.10,
  residualHard: 0.45,
  donorSpreadSoft: 20,
  donorSpreadHard: 60,
  minAlphaGradient: 0.001,
  minAnchors: 2,
  maxRadius: 16,
  hardSceneGuard: 0.72,
  maxPasses: 1
};

test('v1.0.125 removes a watermark-shaped halo that sits outside direct alpha support', () => {
  const { image, alpha, ringMask } = syntheticExteriorHaloScene();
  const beforeError = ringError(image, ringMask);
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, {
    ...permissive,
    detectionConfidence: 0.90,
    outerBandRadius: 3,
    outerBandScale: 0.92
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.equal(diag.attempted, true);
  assert.equal(diag.accepted, true);
  assert.ok(diag.exteriorCandidates > 0);
  assert.ok(diag.exteriorCorrectedPixels > 0);
  assert.ok(diag.exteriorLocalImprovement > 0);
  assert.ok(ringError(result, ringMask) < beforeError);
});

test('v1.0.125 keeps a real crossing scene line guarded while correcting the exterior halo', () => {
  const { image, alpha, ringMask, lineMask } = syntheticExteriorHaloScene({ line: true });
  const before = new Uint8ClampedArray(image.data);
  const result = applyPersistentContourSilhouetteDissolve(image, alpha, {
    ...permissive,
    detectionConfidence: 0.90,
    outerBandRadius: 3,
    outerBandScale: 0.92,
    hardSceneGuard: 0.48
  });
  const diag = result.persistentContourSilhouetteDissolve;
  assert.ok(diag.exteriorCandidates > 0);
  assert.ok(diag.exteriorGuardedPixels > 0);
  let lineDelta = 0;
  let lineCount = 0;
  let ringDelta = 0;
  let ringCount = 0;
  for (let p = 0; p < lineMask.length; p++) {
    const i = p * 4;
    if (lineMask[p]) {
      lineDelta += Math.abs(result.data[i] - before[i]);
      lineCount++;
    }
    if (ringMask[p] && !lineMask[p]) {
      ringDelta += Math.abs(result.data[i] - before[i]);
      ringCount++;
    }
  }
  assert.ok(ringCount > 0 && ringDelta > 0);
  assert.ok(lineCount > 0);
  assert.ok(lineDelta / lineCount < ringDelta / ringCount);
});

test('v1.0.125 limits exterior expansion at medium confidence and still blocks low confidence', () => {
  const { image, alpha } = syntheticExteriorHaloScene();
  const medium = applyPersistentContourSilhouetteDissolve(image, alpha, {
    ...permissive,
    detectionConfidence: 0.41,
    outerBandRadius: 3,
    outerBandScale: 0.92
  });
  const low = applyPersistentContourSilhouetteDissolve(image, alpha, {
    ...permissive,
    detectionConfidence: 0.26,
    outerBandRadius: 3
  });
  const mediumDiag = medium.persistentContourSilhouetteDissolve;
  assert.equal(mediumDiag.confidencePolicy.mode, 'medium');
  assert.ok(mediumDiag.exteriorCandidates > 0);
  assert.ok(mediumDiag.candidateMaxExteriorDistance <= 1.05);
  assert.equal(low.persistentContourSilhouetteDissolve.attempted, false);
  assert.equal(low.persistentContourSilhouetteDissolve.reason, 'low-detection-confidence');
  assert.deepEqual(low.data, image.data);
});

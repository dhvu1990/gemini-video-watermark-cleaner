import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSmoothBackground } from '../src/video/smoothBackground.js';
import { classifyNearEmptyBackground, applySafeEmptyZoneHardSuppression } from '../src/video/emptyZoneHardSuppress.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 14) alpha[y * width + x] = 0.52;
      else if (d <= 17) alpha[y * width + x] = 0.23;
      else if (d <= 20) alpha[y * width + x] = 0.07;
      else if (d <= 22) alpha[y * width + x] = 0.018;
    }
  }
  return alpha;
}

test('empty-zone hard suppression remains eligible only for genuinely low-energy smooth fields', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const mild = makeImage(width, height, (x, y) => [
    68 + x * 0.18 + y * 0.03,
    144 + x * 0.08 + y * 0.11,
    208 + x * 0.05 - y * 0.02
  ]);
  const analysis = analyzeSmoothBackground(mild, alpha);
  const classification = classifyNearEmptyBackground(analysis);
  assert.equal(analysis.safe, true, JSON.stringify(analysis));
  assert.equal(classification.eligible, true, JSON.stringify({ analysis, classification }));
});

test('real diagonal scene detail blocks empty-zone hard suppression before a destructive candidate is attempted', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const detailed = makeImage(width, height, (x, y) => {
    const base = [70 + x * 0.16, 142 + y * 0.12, 204 + x * 0.05];
    const line = Math.abs(y - (0.58 * x + 16)) <= 1.4;
    return line ? [28, 38, 50] : base;
  });
  const analysis = analyzeSmoothBackground(detailed, alpha, {
    maxComplexity: 1,
    maxSurfaceMae: 255,
    maxEdgeDensity: 1,
    maxMeanGradient: 255,
    maxMeanLaplacian: 255,
    maxCoreStructureDensity: 1
  });
  const result = applySafeEmptyZoneHardSuppression(detailed, alpha, { ...analysis, safe: true }, {
    maxComplexity: 1,
    maxSurfaceMae: 255,
    maxEdgeDensity: 1,
    maxMeanGradient: 255,
    maxMeanLaplacian: 255,
    maxCoreStructureDensity: 1
  });
  assert.equal(result.emptyZoneHard.attempted, false, JSON.stringify(result.emptyZoneHard));
  assert.equal(result.emptyZoneHard.reason, 'crossing-scene-edge-protection');
  assert.equal(result.emptyZoneHard.crossingEdge.protect, true);
});

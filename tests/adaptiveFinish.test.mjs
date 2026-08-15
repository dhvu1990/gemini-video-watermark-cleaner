import test from 'node:test';
import assert from 'node:assert/strict';
import { resetAdaptiveFinishState, stabilizeSmoothBackgroundMode } from '../src/video/adaptiveFinish.js';
import { applyDualRingLumaFinish } from '../src/video/dualRingFinish.js';

function smoothAnalysis(overrides = {}) {
  return {
    safe: true,
    mode: 'smooth-rebuild',
    reason: 'smooth-gradient-background',
    coefficients: [Array(6).fill(120), Array(6).fill(130), Array(6).fill(150)],
    complexity: 0.12,
    surfaceMae: 3,
    edgeDensity: 0.01,
    meanGradient: 2,
    meanLaplacian: 1,
    coreStructureDensity: 0.02,
    thresholds: {
      maxComplexity: 0.43,
      maxSurfaceMae: 10.5,
      maxEdgeDensity: 0.13,
      maxMeanGradient: 11.5,
      maxMeanLaplacian: 8.5,
      maxCoreStructureDensity: 0.24
    },
    ...overrides
  };
}

function structuredAnalysis(overrides = {}) {
  return smoothAnalysis({ safe: false, mode: 'structured', reason: 'edge-density', edgeDensity: 0.14, complexity: 0.45, ...overrides });
}

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
      if (d <= 10) alpha[y * width + x] = 0.52;
      else if (d <= 13) alpha[y * width + x] = 0.20;
      else if (d <= 16) alpha[y * width + x] = 0.055;
      else if (d <= 18) alpha[y * width + x] = 0.014;
    }
  }
  return alpha;
}

function overlayWhite(clean, alpha) {
  const out = new Uint8ClampedArray(clean.data);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] || 0;
    if (!a) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(clean.data[i + c] * (1 - a) + 255 * a);
  }
  return { width: clean.width, height: clean.height, data: out };
}

test('temporal mode holds through one borderline structured frame and switches after confirmation', () => {
  resetAdaptiveFinishState();
  assert.equal(stabilizeSmoothBackgroundMode(smoothAnalysis()).mode, 'smooth-rebuild');
  const held = stabilizeSmoothBackgroundMode(structuredAnalysis({ edgeDensity: 0.135, complexity: 0.44 }));
  assert.equal(held.mode, 'smooth-rebuild');
  assert.equal(held.held, true);
  const switched = stabilizeSmoothBackgroundMode(structuredAnalysis({ edgeDensity: 0.135, complexity: 0.44 }));
  assert.equal(switched.mode, 'structured');
  assert.equal(switched.switched, true);
});

test('hard unsafe structure exits smooth mode immediately', () => {
  resetAdaptiveFinishState();
  stabilizeSmoothBackgroundMode(smoothAnalysis());
  const decision = stabilizeSmoothBackgroundMode(structuredAnalysis({ edgeDensity: 0.30, complexity: 0.80 }));
  assert.equal(decision.mode, 'structured');
  assert.equal(decision.hardUnsafe, true);
  assert.equal(decision.switched, true);
});

test('smooth rebuild reports diagnostics after the final reconstructed output', () => {
  resetAdaptiveFinishState();
  const width = 61, height = 61;
  const alpha = diamondAlpha(width, height);
  const clean = makeImage(width, height, (x, y) => [40 + x * 0.45, 100 + y * 0.18, 172 + x * 0.15]);
  const watermarked = overlayWhite(clean, alpha);
  const result = applyDualRingLumaFinish(watermarked, alpha, { strength: 0.56 });
  assert.equal(result.smoothBackground.mode, 'smooth-rebuild');
  assert.equal(result.smoothBackground.applied, true);
  assert.equal(result.dualRingFinish.finalCleanup.source, 'post-smooth-rebuild');
  assert.ok(Number.isFinite(result.dualRingFinish.finalCleanup.after.total));
  assert.ok(result.dualRingFinish.finalCleanup.after.total <= result.dualRingFinish.finalCleanup.before.total * 1.05);
});

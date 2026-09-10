import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyBoundaryAwareBackgroundReconstruction,
  buildBackgroundConfidenceMap
} from '../src/video/boundaryBackgroundReconstruction.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function lumaAt(image, x, y) {
  const idx = (y * image.width + x) * 4;
  return 0.2126 * image.data[idx] + 0.7152 * image.data[idx + 1] + 0.0722 * image.data[idx + 2];
}

function syntheticGradientResidual({ width = 88, height = 88 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const clean = new Float32Array(width * height);
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const radius = 24;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const idx = p * 4;
      const base = 76 + x * 0.62 + y * 0.31;
      const diamond = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
      const a = clamp((1.10 - diamond) * 0.66, 0, 0.66);
      alpha[p] = a;
      clean[p] = base;
      const residual = a > 0.01 ? 17 * Math.min(1, a / 0.38) + (a < 0.16 ? 4 : 0) : 0;
      const value = clamp(base + residual, 0, 255);
      data[idx] = value;
      data[idx + 1] = value + 4;
      data[idx + 2] = value + 8;
      data[idx + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha, clean };
}

function meanCoreError(image, alpha, clean) {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < alpha.length; p++) {
    if ((alpha[p] || 0) < 0.16) continue;
    const x = p % image.width;
    const y = Math.floor(p / image.width);
    sum += Math.abs(lumaAt(image, x, y) - (clean[p] + 3.44));
    count++;
  }
  return count ? sum / count : 0;
}

function syntheticHorizontalStructure({ width = 88, height = 88 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const radius = 24;
  const lineY = Math.round(cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const idx = p * 4;
      const diamond = (Math.abs(x - cx) + Math.abs(y - cy)) / radius;
      const a = clamp((1.10 - diamond) * 0.66, 0, 0.66);
      alpha[p] = a;
      const line = Math.abs(y - lineY) <= 1;
      const base = line ? 72 : 154;
      const residual = a > 0.01 ? (line ? 34 : 12) * Math.min(1, a / 0.30) : 0;
      const value = clamp(base + residual, 0, 255);
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  return { image: { width, height, data }, alpha, lineY, cx: Math.round(cx), cy: Math.round(cy) };
}

test('v1.0.128 confidence map reaches the watermark core from clean exterior boundary donors', () => {
  const { image, alpha } = syntheticGradientResidual();
  const map = buildBackgroundConfidenceMap(image, alpha, null, { maxRadius: 34 });
  const center = Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2);
  assert.ok(alpha[center] > 0.30);
  assert.ok(map.spatialConfidence[center] > 0.25, `spatial=${map.spatialConfidence[center]}`);
  assert.ok(map.directionSupport[center] >= 2, `directions=${map.directionSupport[center]}`);
  assert.ok(map.diagnostics.spatialPixels > 0);
});

test('v1.0.128 reconstructs a broad smooth body residual toward the exterior gradient instead of only polishing the ring', () => {
  const { image, alpha, clean } = syntheticGradientResidual();
  const before = meanCoreError(image, alpha, clean);
  const result = applyBoundaryAwareBackgroundReconstruction(image, alpha, {
    detectionConfidence: 0.92,
    maxRadius: 34,
    maxBlend: 0.78,
    minMeanConfidence: 0.16,
    minLocalImprovement: 0.04,
    maxTotalRatio: 1.20,
    maxLumaRatio: 1.20,
    maxChromaRatio: 1.20
  });
  const diag = result.backgroundReconstruction;
  assert.equal(diag.attempted, true, JSON.stringify(diag));
  assert.equal(diag.accepted, true, JSON.stringify(diag));
  assert.ok(diag.correctedPixels > 40, JSON.stringify(diag));
  assert.ok(meanCoreError(result, alpha, clean) < before * 0.88, JSON.stringify(diag));
});

test('v1.0.128 exposes directional structure confidence when boundary donors disagree across a real line', () => {
  const { image, alpha, lineY, cx } = syntheticHorizontalStructure();
  const map = buildBackgroundConfidenceMap(image, alpha, null, { maxRadius: 34 });
  const p = lineY * image.width + cx;
  const base = p * 3;
  assert.ok(map.spatialConfidence[p] > 0.12, `spatial=${map.spatialConfidence[p]}`);
  assert.ok(map.structureConfidence[p] > 0.20, `structure=${map.structureConfidence[p]}`);
  assert.ok(map.structureTargets[base] < map.spatialTargets[base], `structure=${map.structureTargets[base]} spatial=${map.spatialTargets[base]}`);
});

test('v1.0.128 persistent contour wrapper runs background reconstruction after the body rescue and keeps it confidence-gated', () => {
  const source = readFileSync(new URL('../src/video/persistentContourSilhouetteDissolve.js', import.meta.url), 'utf8');
  assert.match(source, /applyBoundaryAwareBackgroundReconstruction/);
  assert.match(source, /backgroundReconstructionMinConfidence/);
  const bodyIndex = source.indexOf('applyHighConfidenceBodyResidualRescue(');
  const backgroundIndex = source.indexOf('applyBoundaryAwareBackgroundReconstruction(');
  assert.ok(bodyIndex >= 0 && backgroundIndex > bodyIndex);
});

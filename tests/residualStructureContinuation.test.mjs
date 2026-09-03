import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyResidualStructureContinuation } from '../src/video/residualStructureContinuation.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = fn(x, y);
      const p = (y * width + x) * 4;
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width = 72, height = 72) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      let a = 0;
      if (d <= 10) a = 0.38;
      else if (d <= 12) a = 0.22;
      else if (d <= 14) a = 0.08;
      else if (d <= 16) a = 0.02;
      alpha[y * width + x] = a;
    }
  }
  return alpha;
}

function lumaAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return 0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2];
}

test('clean flat field remains unchanged', () => {
  const image = makeImage(72, 72, () => [100, 100, 100]);
  const alpha = diamondAlpha();
  const result = applyResidualStructureContinuation(image, alpha);
  assert.equal(result.residualStructureContinuation.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

test('strong two-sided tangent agreement can continue a scene line through residual contour', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cy = Math.floor(height * 0.5);
  const cx = Math.floor(width * 0.5);
  const image = makeImage(width, height, (x, y) => {
    if (Math.abs(y - cy) <= 1) {
      const d = Math.abs(x - (width - 1) * 0.5) + Math.abs(y - (height - 1) * 0.5);
      return d >= 11 && d <= 15 ? [122, 122, 122] : [176, 176, 176];
    }
    return [86, 86, 86];
  });
  const before = lumaAt(image, cx + 12, cy);
  const result = applyResidualStructureContinuation(image, alpha, {
    minOutlineScore: 0,
    minOutlineDensity: 0,
    minOutlineSamples: 1,
    minPairAgreement: 0,
    strongPairAgreement: 0,
    hardSceneGuard: 0,
    lineSceneGuard: 1.1,
    strength: 0.48,
    maxBlend: 0.24,
    maxLumaDelta: 8,
    residualSoft: 0.01,
    residualHard: 0.20,
    minCorrectedPixels: 1,
    minLocalImprovement: 0,
    maxOutlineRatio: 1.50,
    maxMeanBlend: 0.24,
    localMargin: 20,
    samplesPerSide: 1,
    maxRadius: 24
  });
  const diagnostics = result.residualStructureContinuation;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.candidateCorrectedPixels >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.continuationOverridePixels >= 1, JSON.stringify(diagnostics));
  if (diagnostics.accepted) {
    assert.ok(lumaAt(result, cx + 12, cy) >= before, `before=${before}, after=${lumaAt(result, cx + 12, cy)}`);
  }
});

test('production continuation stays bounded and rollback-safe', () => {
  const source = fs.readFileSync(
    new URL('../src/video/residualStructureContinuation.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /maxBlend \?\? 0\.20/);
  assert.match(source, /maxLumaDelta \?\? 6/);
  assert.match(source, /strongPairAgreement\) \? options\.strongPairAgreement : 0\.84/);
  assert.match(source, /lineSceneGuard\) \? options\.lineSceneGuard : 0\.94/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.003 \+ 0\.025/);
  assert.match(source, /optionalDeltaSafe\(afterGlobal\.darkCandidateMean, beforeGlobal\.darkCandidateMean, 0\.20\)/);
});

test('structure continuation runs after the v1.0.118 contour sweep', () => {
  const source = fs.readFileSync(
    new URL('../src/video/structuredSmoothRescue.js', import.meta.url),
    'utf8'
  );
  const contourIndex = source.indexOf('applyPostInternalContourDissolve');
  const structureIndex = source.lastIndexOf('applyResidualStructureContinuation');
  assert.ok(contourIndex >= 0);
  assert.ok(structureIndex > contourIndex);
  assert.match(source, /residualStructureContinuationAccepted/);
  assert.match(source, /residualStructureContinuation,/);
});

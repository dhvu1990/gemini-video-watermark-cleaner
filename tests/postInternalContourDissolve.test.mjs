import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyPostInternalContourDissolve } from '../src/video/postInternalContourDissolve.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
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
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
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

function permissiveOptions(extra = {}) {
  return {
    enabled: true,
    minAlpha: 0.001,
    maxAlpha: 0.50,
    cleanAlpha: 0.010,
    maxRadius: 22,
    hardSceneGuard: 0.98,
    smoothStrength: 0.70,
    structuredStrength: 0.48,
    smoothMaxBlend: 0.48,
    structuredMaxBlend: 0.36,
    smoothMaxLumaDelta: 14,
    structuredMaxLumaDelta: 11,
    residualSoft: 0.05,
    residualHard: 0.50,
    minCorrectedPixels: 1,
    minLocalImprovement: 0,
    maxMeanBlend: 0.48,
    maxArtifactVetoFraction: 1,
    maxOutlineRatio: 1.30,
    minContourPixels: 1,
    maxPasses: 1,
    maxAnchorSafetyWeight: 0.06,
    localArtifactMargin: 20,
    ...extra
  };
}

test('texture-safe contour dissolve runs after internal residual rescue', () => {
  const source = fs.readFileSync(
    new URL('../src/video/structuredSmoothRescue.js', import.meta.url),
    'utf8'
  );
  const internalIndex = source.indexOf('const internalCandidate = applyInternalResidualRescue');
  const postIndex = source.indexOf('const postContourCandidate = applyPostInternalContourDissolve');
  assert.ok(internalIndex >= 0);
  assert.ok(postIndex > internalIndex);
  assert.match(source, /postInternalContourMaxAlpha, 0\.42/);
  assert.match(source, /postInternalContourStructuredMaxBlend, 0\.27/);
  assert.match(source, /postInternalContourMaxArtifactVetoFraction, 0\.72/);
  assert.match(source, /postInternalContourAccepted/);
});

test('outer-only dissolve reduces a thin watermark contour on a flat field', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const image = makeImage(width, height, (x, y) => {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const contour = d >= 11 && d <= 15;
    const value = contour ? 112 : 100;
    return [value, value, value];
  });
  const x = Math.round(cx);
  const y = Math.round(cy - 13);
  const before = lumaAt(image, x, y);
  const result = applyPostInternalContourDissolve(image, alpha, permissiveOptions());
  const diagnostics = result.postInternalContourDissolve;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.candidateCorrectedPixels >= 1, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, true, JSON.stringify(diagnostics));
  assert.ok(lumaAt(result, x, y) < before, `before=${before}, after=${lumaAt(result, x, y)}`);
});

test('outer-only prediction is not contaminated by a bright watermark core', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const image = makeImage(width, height, (x, y) => {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d <= 9) return [220, 220, 220];
    if (d >= 11 && d <= 15) return [112, 112, 112];
    return [100, 100, 100];
  });
  const x = Math.round(cx);
  const y = Math.round(cy - 13);
  const before = lumaAt(image, x, y);
  const result = applyPostInternalContourDissolve(image, alpha, permissiveOptions());
  const after = lumaAt(result, x, y);
  assert.ok(after < before, `outer-only target must move toward exterior background: before=${before}, after=${after}`);
  assert.ok(after < 112, `bright core must not pull contour brighter: after=${after}`);
});

test('local artifact veto blocks a destructive dark or bright hole proposal', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const image = makeImage(width, height, (x, y) => {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    return d >= 11 && d <= 15 ? [160, 160, 160] : [100, 100, 100];
  });
  const result = applyPostInternalContourDissolve(image, alpha, permissiveOptions({
    localArtifactMargin: 2,
    maxArtifactVetoFraction: 1
  }));
  const diagnostics = result.postInternalContourDissolve;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.artifactVetoPixels > 0, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, false, JSON.stringify(diagnostics));
  assert.deepEqual([...result.data], [...image.data]);
});

test('production caps keep structured texture corrections below smooth-field strength', () => {
  const source = fs.readFileSync(
    new URL('../src/video/postInternalContourDissolve.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /smoothStrength \?\? 0\.58/);
  assert.match(source, /structuredStrength \?\? 0\.34/);
  assert.match(source, /smoothMaxBlend \?\? 0\.42/);
  assert.match(source, /structuredMaxBlend \?\? 0\.27/);
  assert.match(source, /maxAnchorSafetyWeight\) \? options\.maxAnchorSafetyWeight : 0\.04/);
  assert.match(source, /afterGlobal\.darkCandidateMean <= beforeGlobal\.darkCandidateMean \+ 0\.30/);
  assert.match(source, /artifactVetoFraction <= maxArtifactVetoFraction/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyStructuredSmoothRescue } from '../src/video/structuredSmoothRescue.js';

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

function diamondFixture(width = 72, height = 72) {
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
  const image = makeImage(width, height, (x, y) => {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const contour = d >= 11 && d <= 15;
    const value = contour ? 112 : 100;
    return [value, value, value];
  });
  return { image, alpha };
}

test('post-internal contour dissolve runs after internal residual rescue', () => {
  const source = fs.readFileSync(
    new URL('../src/video/structuredSmoothRescue.js', import.meta.url),
    'utf8'
  );
  const internalIndex = source.indexOf('const internalCandidate = applyInternalResidualRescue');
  const postIndex = source.indexOf('const postContourCandidate = applyContourMicroInterpolation');
  assert.ok(internalIndex >= 0);
  assert.ok(postIndex > internalIndex);
  assert.match(source, /postInternalContourMaxAlpha, 0\.42/);
  assert.match(source, /postInternalContourMaxLumaDelta, 9/);
  assert.match(source, /postInternalContourAccepted/);
  assert.match(source, /postInternalContour,/);
});

test('post-internal contour dissolve can correct a thin watermark-shaped outline without earlier rescue passes', () => {
  const { image, alpha } = diamondFixture();
  const result = applyStructuredSmoothRescue(image, alpha, {}, {}, {
    enabled: false,
    finalResidualOptions: { enabled: false },
    outlineEscalationEnabled: false,
    contourMicroInterpolationEnabled: false,
    internalResidualRescueEnabled: false,
    postInternalContourOptions: {
      enabled: true,
      minScore: 0,
      minDensity: 0,
      minSamples: 8,
      minSectors: 2,
      minAlpha: 0.001,
      maxAlpha: 0.50,
      cleanAlpha: 0.010,
      maxRadius: 18,
      hardSceneGuard: 0.80,
      strength: 0.52,
      maxBlend: 0.38,
      maxLumaDelta: 9,
      safetyStrength: 0.48,
      safetyMaxBlend: 0.38,
      residualSoft: 0.10,
      residualHard: 1.0,
      safetyResidualSoft: 0.10,
      safetyResidualHard: 1.0,
      minCorrectedPixels: 1,
      minImprovement: -1,
      maxOutlineRatio: 1.20,
      maxMeanBlend: 0.38,
      localMinImprovement: 0,
      localMaxGuardedFraction: 1,
      localMaxMeanBlend: 0.38,
      maxRescuePasses: 1
    }
  });
  const post = result.structuredSmoothRescue.postInternalContour;
  assert.ok(post, JSON.stringify(result.structuredSmoothRescue));
  assert.equal(post.attempted, true, JSON.stringify(post));
  assert.ok(post.candidateCorrectedPixels >= 1, JSON.stringify(post));
  assert.equal(result.structuredSmoothRescue.postInternalContourAccepted, post.accepted);
});

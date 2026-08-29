import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOutlineResidualEscalation } from '../src/video/outlineResidualEscalation.js';
import { measureGeometricOutlineResidual } from '../src/video/protectedResidualRescue.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = fn(x, y);
    const i = (y * width + x) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { width, height, data };
}

function outlineAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d <= 11) alpha[y * width + x] = 0.42;
    else if (d <= 14) alpha[y * width + x] = 0.18;
    else if (d <= 17) alpha[y * width + x] = 0.075;
    else if (d <= 19) alpha[y * width + x] = 0.025;
  }
  return alpha;
}

function addOutlineImprint(image, alpha, amount = -9) {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 0.02 || alpha[p] > 0.21) continue;
    const i = p * 4;
    out.data[i] = Math.max(0, Math.min(255, out.data[i] + amount));
    out.data[i + 1] = Math.max(0, Math.min(255, out.data[i + 1] + amount));
    out.data[i + 2] = Math.max(0, Math.min(255, out.data[i + 2] + amount));
  }
  return out;
}

function addOuterOutlineImprint(image, alpha, amount = -14) {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 0.02 || alpha[p] > 0.04) continue;
    const i = p * 4;
    out.data[i] = Math.max(0, Math.min(255, out.data[i] + amount));
    out.data[i + 1] = Math.max(0, Math.min(255, out.data[i + 1] + amount));
    out.data[i + 2] = Math.max(0, Math.min(255, out.data[i + 2] + amount));
  }
  return out;
}

function pixelLuma(image, x, y) {
  const i = (y * image.width + x) * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}

test('outline escalation reduces a low-alpha closed diamond contour after body cleanup', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => [94 + x * 0.16, 118 + y * 0.13, 142 + x * 0.09]);
  const damaged = addOutlineImprint(base, alpha, -10);
  const metricOptions = {
    outlineMinAlpha: 0.018,
    outlineMaxAlpha: 0.30,
    outlineResidualSoft: 0.45,
    outlineResidualHard: 3.2
  };
  const before = measureGeometricOutlineResidual(damaged, alpha, metricOptions);
  const result = applyOutlineResidualEscalation(damaged, alpha, {
    minOutlineScore: 0.01,
    minOutlineDensity: 0.001,
    minOutlineSamples: 1,
    minSectorSupport: 1,
    minOutlineDominance: 0.01,
    maxBodyScore: 100,
    maxBodyDensity: 1,
    maxSceneGuardedRatio: 1,
    minImprovement: 0,
    strength: 0.66,
    maxBlend: 0.52,
    residualSoft: 0.45,
    residualHard: 3.2
  });
  const after = measureGeometricOutlineResidual(result, alpha, metricOptions);
  assert.ok(before.score > 0.7, JSON.stringify(before));
  assert.equal(result.outlineResidualEscalation.attempted, true);
  assert.ok(result.outlineResidualEscalation.candidateCorrectedPixels > 0);
  if (result.outlineResidualEscalation.accepted) {
    assert.ok(after.score < before.score, `${before.score} -> ${after.score}`);
    assert.ok(result.outlineResidualEscalation.correctedPixels > 0);
  }
});

test('production outline defaults accept a thin outer diamond residual on a smooth scene', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => [92 + x * 0.10, 116 + y * 0.08, 138 + x * 0.05]);
  const damaged = addOuterOutlineImprint(base, alpha, -14);
  const before = measureGeometricOutlineResidual(damaged, alpha, {
    outlineMinAlpha: 0.018,
    outlineMaxAlpha: 0.30,
    outlineResidualSoft: 0.55,
    outlineResidualHard: 3.8
  });
  const result = applyOutlineResidualEscalation(damaged, alpha);
  const rescue = result.outlineResidualEscalation;
  assert.equal(rescue.strongOutline, true, JSON.stringify(rescue));
  assert.equal(rescue.bodyDensityWeak, false, JSON.stringify(rescue));
  assert.equal(rescue.bodyQuietOverride, true, JSON.stringify(rescue));
  assert.equal(rescue.bodyWeak, true, JSON.stringify(rescue));
  assert.equal(rescue.sceneSafe, true, JSON.stringify(rescue));
  assert.equal(rescue.sceneMode, 'full', JSON.stringify(rescue));
  assert.equal(rescue.attempted, true, JSON.stringify(rescue));
  assert.equal(rescue.accepted, true, JSON.stringify(rescue));
  assert.ok(rescue.correctedPixels > 0, JSON.stringify(rescue));
  assert.ok(rescue.afterOutline.score < before.score, `${before.score} -> ${rescue.afterOutline.score}`);
});

test('production outline defaults keep escalation closed when the body residual is materially strong', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => [96 + x * 0.10, 120 + y * 0.08, 142 + x * 0.05]);
  const damaged = addOutlineImprint(base, alpha, -18);
  const result = applyOutlineResidualEscalation(damaged, alpha);
  const rescue = result.outlineResidualEscalation;
  assert.equal(rescue.strongOutline, true, JSON.stringify(rescue));
  assert.equal(rescue.bodyDensityWeak, false, JSON.stringify(rescue));
  assert.equal(rescue.bodyQuietOverride, false, JSON.stringify(rescue));
  assert.equal(rescue.bodyWeak, false, JSON.stringify(rescue));
  assert.equal(rescue.attempted, false, JSON.stringify(rescue));
  assert.equal(rescue.accepted, false, JSON.stringify(rescue));
});

test('outline escalation does not materially erase a strong real crossing line', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => {
    const crossing = Math.abs(y - (0.48 * x + 20)) <= 1.25;
    return crossing ? [34, 38, 44] : [105 + x * 0.10, 128 + y * 0.10, 150 + x * 0.06];
  });
  const damaged = addOutlineImprint(base, alpha, -7);
  const result = applyOutlineResidualEscalation(damaged, alpha, {
    minOutlineScore: 0.20,
    minOutlineDensity: 0.01,
    minOutlineSamples: 6,
    minSectorSupport: 3,
    minOutlineDominance: 0.30,
    maxBodyScore: 10,
    maxBodyDensity: 1,
    maxSceneGuardedRatio: 0.34,
    hardSceneGuard: 0.62,
    minImprovement: 0.001
  });
  let maxCrossingDelta = 0;
  for (let x = 22; x <= 58; x++) {
    const y = Math.round(0.48 * x + 20);
    const delta = Math.abs(pixelLuma(result, x, y) - pixelLuma(damaged, x, y));
    maxCrossingDelta = Math.max(maxCrossingDelta, delta);
  }
  assert.ok(maxCrossingDelta <= 5.5, `crossing-line luma delta=${maxCrossingDelta}`);
  if (result.outlineResidualEscalation.accepted) {
    assert.ok(result.outlineResidualEscalation.meanBlend < 0.49);
  }
});

test('localized crossing scene edge can use partial protected outline cleanup away from the real line', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => {
    const crossing = Math.abs(y - (0.48 * x + 20)) <= 1.25;
    return crossing ? [34, 38, 44] : [105 + x * 0.10, 128 + y * 0.10, 150 + x * 0.06];
  });
  const damaged = addOuterOutlineImprint(base, alpha, -16);
  const before = measureGeometricOutlineResidual(damaged, alpha, {
    outlineMinAlpha: 0.018,
    outlineMaxAlpha: 0.30,
    outlineResidualSoft: 0.45,
    outlineResidualHard: 3.2
  });
  const result = applyOutlineResidualEscalation(damaged, alpha, {
    minOutlineScore: 0.15,
    minOutlineDensity: 0.005,
    minOutlineSamples: 4,
    minSectorSupport: 2,
    minOutlineDominance: 0.01,
    maxBodyScore: 100,
    maxBodyDensity: 1,
    lowBodyScoreOverride: 100,
    maxSceneGuardedRatio: 0.70,
    maxCrossingSceneEdgeScore: 0.01,
    partialMinOutlineScore: 0.15,
    partialMinOutlineDensity: 0.005,
    partialMinOutlineSamples: 4,
    maxPartialCrossingSceneEdgeScore: 1,
    maxPartialSceneEdgeDensity: 0.25,
    maxPartialSceneEdgeContinuityDensity: 0.20,
    partialHardSceneGuard: 0.45,
    partialMinImprovement: -0.01,
    partialMaxOutlineRatio: 1.01,
    minCorrectedPixels: 1,
    residualSoft: 0.45,
    residualHard: 3.2
  });
  const rescue = result.outlineResidualEscalation;
  assert.equal(rescue.sceneSafe, false, JSON.stringify(rescue.crossingSceneEdge));
  assert.equal(rescue.partialSceneProtected, true, JSON.stringify(rescue));
  assert.equal(rescue.sceneMode, 'partial-protected', JSON.stringify(rescue));
  assert.equal(rescue.attempted, true, JSON.stringify(rescue));
  assert.ok(rescue.candidateCorrectedPixels > 0, JSON.stringify(rescue));
  assert.ok(rescue.effectiveHardSceneGuard <= 0.45, JSON.stringify(rescue));

  let maxCrossingDelta = 0;
  for (let x = 22; x <= 58; x++) {
    const y = Math.round(0.48 * x + 20);
    maxCrossingDelta = Math.max(maxCrossingDelta, Math.abs(pixelLuma(result, x, y) - pixelLuma(damaged, x, y)));
  }
  assert.ok(maxCrossingDelta <= 4.0, `partial crossing-line luma delta=${maxCrossingDelta}`);
  if (rescue.accepted) {
    assert.ok(rescue.afterOutline.score <= before.score * 1.01, `${before.score} -> ${rescue.afterOutline.score}`);
  }
});

test('partial scene protection stays closed when crossing structure covers too much of the ROI', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => {
    const stripe = (x % 6 <= 1) || (y % 6 <= 1);
    return stripe ? [32, 36, 42] : [112 + x * 0.08, 130 + y * 0.08, 148 + x * 0.04];
  });
  const damaged = addOuterOutlineImprint(base, alpha, -16);
  const result = applyOutlineResidualEscalation(damaged, alpha, {
    minOutlineScore: 0.01,
    minOutlineDensity: 0.001,
    minOutlineSamples: 1,
    minSectorSupport: 1,
    minOutlineDominance: 0.01,
    maxBodyScore: 100,
    maxBodyDensity: 1,
    lowBodyScoreOverride: 100,
    maxSceneGuardedRatio: 1,
    maxCrossingSceneEdgeScore: 0,
    partialMinOutlineScore: 0.01,
    partialMinOutlineDensity: 0.001,
    partialMinOutlineSamples: 1,
    maxPartialCrossingSceneEdgeScore: 1,
    maxPartialSceneEdgeDensity: 0.02,
    maxPartialSceneEdgeContinuityDensity: 0.01
  });
  const rescue = result.outlineResidualEscalation;
  assert.equal(rescue.sceneSafe, false, JSON.stringify(rescue.crossingSceneEdge));
  assert.equal(rescue.partialSceneGate.coverageSafe, false, JSON.stringify(rescue.partialSceneGate));
  assert.equal(rescue.partialSceneProtected, false, JSON.stringify(rescue));
  assert.equal(rescue.sceneMode, 'blocked', JSON.stringify(rescue));
  assert.equal(rescue.attempted, false, JSON.stringify(rescue));
});

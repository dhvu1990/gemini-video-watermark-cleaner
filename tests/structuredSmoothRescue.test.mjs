import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStructuredSmoothRescue,
  evaluateStructuredSmoothRescueEligibility
} from '../src/video/structuredSmoothRescue.js';

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
      alpha[y * width + x] = d <= 11 ? 0.32 : (d <= 15 ? 0.12 : (d <= 18 ? 0.035 : 0));
    }
  }
  return alpha;
}

function smoothAnalysis(rgb) {
  return {
    safe: false,
    reason: 'core-structure',
    coefficients: rgb.map((value) => [value, 0, 0, 0, 0, 0]),
    surfaceMae: 0.5,
    edgeDensity: 0.01,
    meanGradient: 0.8,
    meanLaplacian: 0.8,
    coreStructureDensity: 0.30,
    complexity: 0.18,
    exteriorMeanCb: 4,
    exteriorMeanCr: -3,
    exteriorChromaMagnitude: 5,
    exteriorChromaSpread: 2,
    neutralChromaConfidence: 0.7
  };
}

function flatResidualFixture() {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height);
  const base = [24, 48, 72];
  const image = makeImage(width, height, (x, y) => {
    const a = alpha[y * width + x] || 0;
    const lift = Math.round(a * 55);
    return base.map((v) => v + lift);
  });
  return { width, height, alpha, base, image };
}

function rescueOptions(extra = {}) {
  return {
    minAlignedScore: 0.05,
    minAlignedDensity: 0.001,
    minAlignedImprovement: 0.04,
    maxAlignedRatio: 0.96,
    maxTotalRatio: 1.01,
    maxLumaRatio: 1.01,
    maxChromaRatio: 1.05,
    ...extra
  };
}

function pixelLuma(image, x, y) {
  const i = (y * image.width + x) * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}

test('structured smooth rescue evaluates a watermark-shaped candidate with the guard disabled', () => {
  const { alpha, base, image } = flatResidualFixture();
  const result = applyStructuredSmoothRescue(
    image,
    alpha,
    smoothAnalysis(base),
    { alignedBefore: { score: 4 }, alignedAfter: { score: 3.9 } },
    rescueOptions({ artifactGuardOptions: { enabled: false } })
  );
  const rescue = result.structuredSmoothRescue;
  assert.equal(rescue.attempted, true, JSON.stringify(rescue));
  assert.ok(rescue.artifactGuard, JSON.stringify(rescue));
  assert.equal(rescue.artifactGuard.rollback, false, JSON.stringify(rescue.artifactGuard));
  assert.equal(rescue.artifactGuard.reason, 'disabled', JSON.stringify(rescue.artifactGuard));
  assert.equal(rescue.structuredAccepted, rescue.structuredMetricsAccepted, JSON.stringify(rescue));
  assert.ok(Number.isFinite(rescue.candidateAlignedImprovement), JSON.stringify(rescue));
});

test('structured smooth rescue honors both metric gates and the artifact guard decision', () => {
  const { alpha, base, image } = flatResidualFixture();
  const result = applyStructuredSmoothRescue(
    image,
    alpha,
    smoothAnalysis(base),
    { alignedBefore: { score: 4 }, alignedAfter: { score: 3.9 } },
    rescueOptions()
  );
  const rescue = result.structuredSmoothRescue;
  assert.equal(rescue.structuredAttempted, true, JSON.stringify(rescue));
  assert.ok(rescue.artifactGuard, JSON.stringify(rescue));
  assert.equal(
    rescue.structuredAccepted,
    rescue.structuredMetricsAccepted && !rescue.artifactGuard.rollback,
    JSON.stringify(rescue)
  );
});

test('accepted final visual rescue still runs post-chain outline verification', () => {
  const { alpha, base, image } = flatResidualFixture();
  const result = applyStructuredSmoothRescue(
    image,
    alpha,
    smoothAnalysis(base),
    { alignedBefore: { score: 4 }, alignedAfter: { score: 3.9 } },
    rescueOptions({
      enabled: false,
      finalResidualMinScore: 0.01,
      finalResidualMinDensity: 0.001,
      finalResidualMinSamples: 8,
      finalResidualMinImprovement: 0.001
    })
  );
  const rescue = result.structuredSmoothRescue;
  assert.equal(rescue.finalVisualAccepted, true, JSON.stringify(rescue.finalVisualResidual));
  assert.ok(rescue.outlineResidualEscalation, JSON.stringify(rescue));
  assert.equal(typeof rescue.outlineResidualEscalation.eligible, 'boolean');
  assert.ok(rescue.postChainOutlineResidual, JSON.stringify(rescue));
  assert.equal(typeof rescue.postChainOutlineResidual.strong, 'boolean');
});

test('structured smooth rescue is blocked by a real crossing scene edge', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height);
  const image = makeImage(width, height, (x) => x < width / 2 ? [18, 32, 52] : [205, 190, 160]);
  const gate = evaluateStructuredSmoothRescueEligibility(
    image,
    alpha,
    smoothAnalysis([80, 80, 80]),
    { alignedBefore: { score: 4 }, alignedAfter: { score: 3.9 } },
    { minAlignedScore: 0, minAlignedDensity: 0, maxSceneEdgeScore: 1 }
  );
  assert.equal(gate.sceneSafe, false, JSON.stringify(gate.sceneEdge));
  assert.equal(gate.eligible, false, JSON.stringify(gate));
});

test('post-chain outline verification keeps a crossing scene line protected', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height);
  const image = makeImage(width, height, (x, y) => {
    const crossing = Math.abs(y - (0.48 * x + 18)) <= 1.25;
    return crossing ? [32, 36, 42] : [108 + x * 0.08, 126 + y * 0.08, 146 + x * 0.04];
  });
  const result = applyStructuredSmoothRescue(
    image,
    alpha,
    {},
    {},
    {
      enabled: false,
      finalResidualOptions: { enabled: false },
      outlineEscalationOptions: {
        minOutlineScore: 0.01,
        minOutlineDensity: 0.001,
        minOutlineSamples: 8,
        minSectorSupport: 3,
        minOutlineDominance: 0.01,
        maxBodyScore: 100,
        maxBodyDensity: 1,
        minImprovement: 0
      }
    }
  );
  const outline = result.structuredSmoothRescue.outlineResidualEscalation;
  assert.ok(outline, JSON.stringify(result.structuredSmoothRescue));
  assert.equal(outline.sceneSafe, false, JSON.stringify(outline.crossingSceneEdge));
  assert.equal(outline.accepted, false, JSON.stringify(outline));
  let maxCrossingDelta = 0;
  for (let x = 20; x <= 52; x++) {
    const y = Math.round(0.48 * x + 18);
    maxCrossingDelta = Math.max(maxCrossingDelta, Math.abs(pixelLuma(result, x, y) - pixelLuma(image, x, y)));
  }
  assert.ok(maxCrossingDelta <= 0.5, `crossing-line luma delta=${maxCrossingDelta}`);
});

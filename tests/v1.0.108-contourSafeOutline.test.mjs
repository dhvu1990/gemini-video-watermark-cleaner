import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOutlineResidualEscalation } from '../src/video/outlineResidualEscalation.js';
import { batchBackgroundLabel, buildBatchDetectionView } from '../src/batchPreviewModel.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = fn(x, y);
    const i = (y * width + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
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

function addOutlineImprint(image, alpha, amount = -18) {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 0.02 || alpha[p] > 0.21) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.max(0, Math.min(255, out.data[i + c] + amount));
  }
  return out;
}

test('explicit contour-body override evaluates a strong closed outline after the broad-body gate stalls', () => {
  const width = 81, height = 81;
  const alpha = outlineAlpha(width, height);
  const base = makeImage(width, height, (x, y) => [96 + x * 0.10, 120 + y * 0.08, 142 + x * 0.05]);
  const damaged = addOutlineImprint(base, alpha);
  const common = {
    minOutlineScore: 0.01,
    minOutlineDensity: 0.001,
    minOutlineSamples: 1,
    minSectorSupport: 1,
    minOutlineDominance: 0.01,
    maxBodyScore: 0,
    maxBodyDensity: 0,
    lowBodyScoreOverride: 0,
    maxSceneGuardedRatio: 1,
    maxCrossingSceneEdgeScore: 1,
    sceneEdgeOptions: { minGradient: 1000, fullGradient: 2000 },
    minCorrectedPixels: 1
  };

  const blocked = applyOutlineResidualEscalation(damaged, alpha, {
    ...common,
    contourBodyOverride: false
  }).outlineResidualEscalation;
  assert.equal(blocked.bodyWeak, false, JSON.stringify(blocked));
  assert.equal(blocked.contourBodyOverride, false, JSON.stringify(blocked));
  assert.equal(blocked.attempted, false, JSON.stringify(blocked));

  const enabled = applyOutlineResidualEscalation(damaged, alpha, {
    ...common,
    contourBodyOverride: true,
    bodyOverrideMinOutlineScore: 0.01,
    bodyOverrideMinOutlineDensity: 0.001,
    bodyOverrideMinOutlineSamples: 1,
    bodyOverrideMinSectorSupport: 1,
    bodyOverrideMaxBodyScore: 100,
    bodyOverrideMinDominance: 0.05,
    bodyOverrideMinImprovement: -0.01,
    bodyOverrideMaxOutlineRatio: 1.01
  }).outlineResidualEscalation;
  assert.equal(enabled.contourBodyOverride, true, JSON.stringify(enabled));
  assert.equal(enabled.bodyMode, 'contour-only-override', JSON.stringify(enabled));
  assert.equal(enabled.attempted, true, JSON.stringify(enabled));
  assert.ok(enabled.candidateCorrectedPixels > 0, JSON.stringify(enabled));
  assert.ok(enabled.effectiveMaxLumaDelta <= 8, JSON.stringify(enabled));
});

test('production rescue explicitly enables safe partial and contour-body outline modes', () => {
  const source = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');
  assert.match(source, /partialSceneProtection: options\.outlineEscalationPartialSceneProtection !== false/);
  assert.match(source, /contourBodyOverride: options\.outlineEscalationContourBodyOverride !== false/);
  assert.match(source, /postChainOutlineSceneSafe = outlineResidualEscalation\?\.sceneEligible !== false/);
});

test('batch diagnostics distinguish a rejected protected attempt from a globally blocked scene', () => {
  const preview = {
    antiStreak: { riskFlags: [] },
    structuredSmoothRescue: {
      acceptedMode: 'final-visual-residual-rescue',
      finalVisualResidual: {
        attempted: true,
        accepted: true,
        before: { score: 2.4, candidateDensity: 0.20, samples: 60 },
        after: { score: 1.3, candidateDensity: 0.10, samples: 28 }
      },
      outlineResidualEscalation: {
        attempted: true,
        accepted: false,
        sceneSafe: false,
        sceneEligible: true,
        sceneMode: 'partial-protected',
        partialSceneProtected: true,
        bodyMode: 'contour-only-override',
        contourBodyOverride: true
      },
      postChainOutlineResidual: {
        score: 1.7,
        candidateDensity: 0.14,
        samples: 38,
        sectorSupport: 4,
        strong: true
      },
      postChainOutlineSceneSafe: true
    }
  };
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.92,
    candidateId: 'veo-portrait-1080-inset',
    position: { x: 864, y: 1704, width: 72, height: 72 }
  }, preview);
  assert.match(view.riskFlags, /outline-partial-scene-protection/);
  assert.match(view.riskFlags, /outline-contour-body-override/);
  assert.match(view.riskFlags, /outline-residual-escalation-rejected/);
  assert.match(view.riskFlags, /post-chain-outline-watermark-residual/);
  assert.doesNotMatch(view.riskFlags, /post-chain-outline-scene-protected/);

  preview.structuredSmoothRescue.acceptedMode = 'final-visual+outline-escalation';
  preview.structuredSmoothRescue.outlineResidualEscalation.accepted = true;
  assert.equal(batchBackgroundLabel(preview), 'Protected contour-only outline rescue');
});

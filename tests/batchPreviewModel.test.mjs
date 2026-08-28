import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchBackgroundLabel,
  buildBatchDetectionView,
  humanizeBatchCandidate,
  sameBatchInspectOptions
} from '../src/batchPreviewModel.js';

test('batch candidate IDs are presented like the single-video auto-detect heading', () => {
  assert.equal(humanizeBatchCandidate('veo-portrait-720-relocated@1.2'), 'Portrait 720 Relocated');
  assert.equal(humanizeBatchCandidate('veo-landscape-1080-standard'), 'Landscape 1080 Standard');
});

test('batch detection view exposes match, ROI, background mode and risk flags', () => {
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.432,
    candidateId: 'veo-portrait-720-relocated@2',
    position: { x: 551.7, y: 773.2, width: 72, height: 72 }
  }, {
    dualRingFinish: { smoothBackground: { mode: 'structured-fallback' } },
    antiStreak: { riskFlags: ['high-contrast-adjacency'] }
  });

  assert.equal(view.ready, true);
  assert.equal(view.matchPercent, 43);
  assert.match(view.title, /Portrait 720 Relocated \(43% match\)/);
  assert.deepEqual(view.position, { x: 552, y: 773, width: 72, height: 72 });
  assert.equal(view.riskFlags, 'high-contrast-adjacency');
});

test('batch background labels mirror the main preview cleanup mode', () => {
  assert.equal(batchBackgroundLabel({ dualRingFinish: { smoothBackground: { mode: 'smooth-rebuild' } } }), 'Smooth background rebuild');
  assert.equal(batchBackgroundLabel({ dualRingFinish: { smoothBackground: { mode: 'empty-hard-rebuild' } } }), 'Safe empty-zone hard suppression');
  assert.equal(batchBackgroundLabel({ structuredSmoothRescue: { acceptedMode: 'final-visual-residual-rescue' } }), 'Final visual residual rescue');
  assert.equal(batchBackgroundLabel({ structuredSmoothRescue: { acceptedMode: 'outline-residual-escalation' } }), 'Outline residual escalation');
  assert.equal(batchBackgroundLabel({ structuredSmoothRescue: { acceptedMode: 'final-visual+outline-escalation' } }), 'Final visual + outline escalation');
  assert.equal(batchBackgroundLabel(null), 'Structured-background fallback');
});

test('final visual verifier surfaces a residual even when legacy risk flags are empty', () => {
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.93,
    candidateId: 'veo-portrait-1080-inset',
    position: { x: 864, y: 1704, width: 72, height: 72 }
  }, {
    antiStreak: { riskFlags: [] },
    structuredSmoothRescue: {
      acceptedMode: 'none',
      finalVisualResidual: {
        attempted: true,
        accepted: false,
        before: { score: 2.2, candidateDensity: 0.18, samples: 54 }
      }
    }
  });
  assert.match(view.riskFlags, /final-residual-rescue-rejected/);
  assert.match(view.riskFlags, /final-visual-watermark-residual/);
});

test('accepted final visual rescue is labeled without a stale residual warning', () => {
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.91,
    candidateId: 'veo-portrait-1080-inset',
    position: { x: 864, y: 1704, width: 72, height: 72 }
  }, {
    antiStreak: { riskFlags: [] },
    structuredSmoothRescue: {
      acceptedMode: 'final-visual-residual-rescue',
      finalVisualResidual: {
        attempted: true,
        accepted: true,
        before: { score: 2.4, candidateDensity: 0.20, samples: 61 },
        after: { score: 0.7, candidateDensity: 0.08, samples: 21 }
      },
      postChainOutlineResidual: { score: 0.7, candidateDensity: 0.04, samples: 8, sectorSupport: 2, strong: false },
      postChainOutlineSceneSafe: true
    }
  });
  assert.equal(view.note, 'Final visual residual rescue');
  assert.equal(view.riskFlags, 'none');
});

test('post-chain outline verifier flags a strong contour after an accepted final rescue', () => {
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.93,
    candidateId: 'veo-portrait-1080-inset',
    position: { x: 864, y: 1704, width: 72, height: 72 }
  }, {
    antiStreak: { riskFlags: [] },
    structuredSmoothRescue: {
      acceptedMode: 'final-visual-residual-rescue',
      finalVisualResidual: {
        attempted: true,
        accepted: true,
        before: { score: 2.3, candidateDensity: 0.18, samples: 52 },
        after: { score: 0.72, candidateDensity: 0.06, samples: 17 }
      },
      outlineResidualEscalation: {
        attempted: false,
        accepted: false,
        sceneSafe: true
      },
      postChainOutlineResidual: {
        score: 1.62,
        candidateDensity: 0.13,
        samples: 34,
        sectorSupport: 4,
        strong: true
      },
      postChainOutlineSceneSafe: true
    }
  });
  assert.match(view.riskFlags, /post-chain-outline-watermark-residual/);
});

test('post-chain outline verifier reports scene-protected structure instead of treating it as safe cleanup', () => {
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.74,
    candidateId: 'veo-portrait-1080-inset',
    position: { x: 864, y: 1704, width: 72, height: 72 }
  }, {
    antiStreak: { riskFlags: [] },
    structuredSmoothRescue: {
      acceptedMode: 'none',
      outlineResidualEscalation: {
        attempted: false,
        accepted: false,
        sceneSafe: false
      },
      postChainOutlineResidual: {
        score: 1.55,
        candidateDensity: 0.12,
        samples: 31,
        sectorSupport: 4,
        strong: true
      },
      postChainOutlineSceneSafe: false
    }
  });
  assert.match(view.riskFlags, /post-chain-outline-scene-protected/);
  assert.doesNotMatch(view.riskFlags, /post-chain-outline-watermark-residual/);
});

test('cached batch inspect results are reused only while relevant inspect settings match', () => {
  const options = { sampleCount: 12, minConfidence: 0.12, edgePolish: 0.35, scanFraction: 1 };
  assert.equal(sameBatchInspectOptions(options, { ...options }), true);
  assert.equal(sameBatchInspectOptions(options, { ...options, sampleCount: 18 }), false);
  assert.equal(sameBatchInspectOptions(null, options), false);
});

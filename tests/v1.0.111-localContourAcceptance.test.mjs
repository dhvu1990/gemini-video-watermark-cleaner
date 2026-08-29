import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBatchDetectionView } from '../src/batchPreviewModel.js';

const rescueSource = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');

test('v1.0.111 only relaxes conservative outline acceptance thresholds', () => {
  assert.match(rescueSource, /outlineEscalationPartialMinImprovement, 0\.012/);
  assert.match(rescueSource, /outlineEscalationPartialMaxOutlineRatio, 0\.988/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideMinImprovement, 0\.015/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideMaxOutlineRatio, 0\.985/);
  assert.match(rescueSource, /outlineEscalationStrength, 0\.58/);
  assert.match(rescueSource, /outlineEscalationPartialStrength, 0\.46/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideStrength, 0\.44/);
});

test('batch diagnostics identify the concrete outline acceptance gate that rejected a candidate', () => {
  const view = buildBatchDetectionView(
    {
      detected: true,
      confidence: 0.9,
      candidateId: 'veo-portrait-1080-inset',
      position: { x: 864, y: 1704, width: 72, height: 72 }
    },
    {
      structuredSmoothRescue: {
        outlineResidualEscalation: {
          attempted: true,
          accepted: false,
          partialSceneProtected: true,
          candidateCorrectedPixels: 20,
          candidateMeanBlend: 0.2,
          candidateImprovement: 0.005,
          minImprovement: 0.012,
          maxMeanBlend: 0.42,
          maxOutlineRatio: 0.988,
          beforeOutline: { score: 2.0 },
          candidateAfterOutline: { score: 1.99 },
          beforeGlobal: { total: 1, luma: 1, chroma: 1 },
          candidateAfterGlobal: { total: 1, luma: 1, chroma: 1 }
        },
        postChainOutlineResidual: {
          score: 2,
          candidateDensity: 0.1,
          samples: 20,
          sectorSupport: 4,
          strong: true
        },
        postChainOutlineSceneSafe: true
      }
    }
  );
  assert.match(view.riskFlags, /outline-residual-escalation-rejected/);
  assert.match(view.riskFlags, /outline-reject-local-improvement/);
  assert.match(view.riskFlags, /outline-reject-outline-ratio/);
});

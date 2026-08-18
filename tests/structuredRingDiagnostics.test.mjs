import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStructuredRingDiagnostics } from '../src/video/structuredRingDiagnostics.js';

test('summarizes aligned ring residual density and downstream finisher states', () => {
  const summary = summarizeStructuredRingDiagnostics({
    enabled: true,
    attempted: true,
    accepted: true,
    ringAccepted: true,
    acceptedMode: 'primary+shape-ghost+outer-halo',
    alignedBefore: { score: 2.4, samples: 120 },
    alignedAfter: { score: 1.8, samples: 118 },
    correctedPixels: 44,
    candidatePixels: 61,
    salvageAttempted: false,
    salvageAccepted: false,
    consensus: { enabled: true, attempted: true, accepted: false },
    shapeGhost: { enabled: true, attempted: true, accepted: true },
    centerSeam: { enabled: true, attempted: true, accepted: false },
    localToneMatch: { enabled: true, attempted: true, accepted: false },
    outerHalo: { enabled: true, attempted: true, accepted: true }
  }, 2400);

  assert.equal(summary.alignedBeforeScore, 2.4);
  assert.equal(summary.alignedAfterScore, 1.8);
  assert.equal(summary.alignedSampleCount, 120);
  assert.equal(summary.alignedSampleDensity, 0.05);
  assert.ok(Math.abs(summary.alignedImprovement - 0.25) < 1e-12);
  assert.equal(summary.shapeGhost.accepted, true);
  assert.equal(summary.outerHalo.accepted, true);
});

test('empty structured-ring data produces stable zero diagnostics', () => {
  const summary = summarizeStructuredRingDiagnostics();
  assert.equal(summary.attempted, false);
  assert.equal(summary.accepted, false);
  assert.equal(summary.alignedBeforeScore, 0);
  assert.equal(summary.alignedAfterScore, 0);
  assert.equal(summary.alignedSampleCount, 0);
  assert.equal(summary.alignedSampleDensity, 0);
  assert.equal(summary.alignedImprovement, 0);
  assert.equal(summary.acceptedMode, 'none');
});

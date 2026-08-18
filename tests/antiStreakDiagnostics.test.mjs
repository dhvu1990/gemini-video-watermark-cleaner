import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAntiStreakDiagnostics } from '../src/video/antiStreakDiagnostics.js';

test('anti-streak summary flags rejected temporal donor, active structure guard, donor spread and dense ring residual', () => {
  const summary = summarizeAntiStreakDiagnostics({
    temporalDonorAcceptance: {
      attempted: true,
      accepted: false,
      reason: 'residual-safety-gate',
      totalRatio: 1.01,
      lumaRatio: 1.008,
      chromaRatio: 1.012
    },
    temporalDonor: {
      candidatePixels: 100,
      correctedPixels: 44,
      guardedPixels: 36,
      meanStructureConfidence: 0.61,
      meanStructureMismatch: 0.53
    },
    atlas: {
      donorCount: 4,
      supportedPixels: 320,
      meanConfidence: 0.47,
      meanDonorSpread: 22,
      allowMaskedDonors: true
    },
    structuredRingDiagnostics: {
      attempted: true,
      accepted: false,
      acceptedMode: 'none',
      alignedBeforeScore: 2.1,
      alignedAfterScore: 2.08,
      alignedSampleDensity: 0.025,
      alignedImprovement: 0.0095,
      consensus: { accepted: false },
      shapeGhost: { accepted: false },
      centerSeam: { accepted: false },
      localToneMatch: { accepted: false },
      outerHalo: { accepted: false }
    }
  });

  assert.equal(summary.temporalDonor.rejected, true);
  assert.equal(summary.temporalDonor.guardedRatio, 0.36);
  assert.equal(summary.atlas.meanDonorSpread, 22);
  assert.deepEqual(summary.riskFlags, [
    'temporal-donor-rejected',
    'temporal-donor-structure-guard-active',
    'high-donor-spread',
    'dense-structured-ring-residual',
    'structured-cleanup-low-gain'
  ]);
});

test('accepted structured low-gain residual from real preview telemetry is flagged', () => {
  const summary = summarizeAntiStreakDiagnostics({
    structuredRingDiagnostics: {
      attempted: true,
      accepted: true,
      acceptedMode: 'primary+shape-ghost',
      alignedBeforeScore: 1.720,
      alignedAfterScore: 1.635,
      alignedSampleDensity: 0.048,
      alignedImprovement: 0.049
    }
  });

  assert.equal(summary.structured.accepted, true);
  assert.equal(summary.structured.acceptedLowGain, true);
  assert.ok(summary.riskFlags.includes('accepted-structured-low-gain'));
});

test('accepted structured cleanup with healthy improvement stays quiet', () => {
  const summary = summarizeAntiStreakDiagnostics({
    structuredRingDiagnostics: {
      attempted: true,
      accepted: true,
      acceptedMode: 'primary',
      alignedBeforeScore: 1.72,
      alignedAfterScore: 1.42,
      alignedSampleDensity: 0.048,
      alignedImprovement: 0.174
    }
  });

  assert.equal(summary.structured.acceptedLowGain, false);
  assert.ok(!summary.riskFlags.includes('accepted-structured-low-gain'));
});

test('anti-streak summary is stable and quiet for empty diagnostics', () => {
  const summary = summarizeAntiStreakDiagnostics();
  assert.equal(summary.temporalDonor.attempted, false);
  assert.equal(summary.temporalDonor.accepted, false);
  assert.equal(summary.temporalDonor.guardedRatio, 0);
  assert.equal(summary.atlas.donorCount, 0);
  assert.equal(summary.structured.alignedBeforeScore, 0);
  assert.deepEqual(summary.riskFlags, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCalibrationRerank } from '../src/video/calibrationRerankDiagnostics.js';

test('summarizes rerank counts, coverage gate and selected artifact penalty', () => {
  const base = {
    profile: '96', shapeScale: 1, edgeBoost: 0.03, edgeGain: 1,
    offsetX: 0, offsetY: 0, bodyGain: 1,
    selectionScore: 10,
    finalScore: 10.44,
    artifactCoverageEligible: true,
    artifactResidual: { score: 8, coverage: 1 }
  };
  const cleaner = {
    profile: '96', shapeScale: 1, edgeBoost: 0.03, edgeGain: 1,
    offsetX: 0.4, offsetY: 0, bodyGain: 1,
    selectionScore: 10.03,
    finalScore: 10.052,
    artifactCoverageEligible: true,
    artifactResidual: { score: 0.4, coverage: 1 }
  };
  const summary = summarizeCalibrationRerank({
    selected: cleaner,
    evaluated: [cleaner, base],
    topN: 2,
    inputCount: 63,
    uniqueCount: 62,
    duplicateCount: 1,
    eligibleCount: 2,
    excludedByGap: 60,
    bestSelectionScore: 10,
    maxRelativeGap: 0.02,
    maxAbsoluteGap: 0.2,
    minCoverage: 0.4
  });

  assert.equal(summary.selectedChangedFromBase, true);
  assert.equal(summary.selectedBaseScore, 10.03);
  assert.equal(summary.selectedFinalScore, 10.052);
  assert.ok(Math.abs(summary.selectedArtifactPenalty - 0.022) < 1e-9);
  assert.equal(summary.selectedArtifactCoverage, 1);
  assert.equal(summary.minCoverage, 0.4);
  assert.equal(summary.duplicateCount, 1);
  assert.equal(summary.excludedByGap, 60);
  assert.equal(summary.evaluated.length, 2);
});

test('empty rerank data produces a stable zero-value diagnostic object', () => {
  const summary = summarizeCalibrationRerank();
  assert.equal(summary.topN, 0);
  assert.equal(summary.selectedChangedFromBase, false);
  assert.equal(summary.selectedIdentity, null);
  assert.equal(summary.baseWinnerIdentity, null);
  assert.deepEqual(summary.evaluated, []);
});

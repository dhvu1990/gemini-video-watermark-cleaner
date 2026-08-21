import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFaintAnchorCalibration, evaluateFaintAnchorSafety } from '../src/video/faintAnchorSafety.js';

function faintScores() {
  return Array.from({ length: 12 }, (_, i) => ({
    spatial: i < 9 ? 0.028 : 0.008,
    gradient: i < 9 ? 0.052 : 0.011,
    confidence: i < 9 ? 0.064 : 0.028
  }));
}

test('faint exact portrait anchor can enter calibration verification', () => {
  const result = evaluateFaintAnchorSafety({
    confidence: 0.06,
    maxConfidence: 0.081,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-standard@0,0',
    refinement: { baseCandidateId: 'veo-portrait-1080-standard', dx: 0, dy: 0 },
    scores: faintScores()
  });
  assert.equal(result.safe, true, JSON.stringify(result));
});

test('regional candidate cannot use faint-anchor bypass', () => {
  const result = evaluateFaintAnchorSafety({
    confidence: 0.09,
    maxConfidence: 0.16,
    minConfidence: 0.12,
    candidateId: 'veo-regional-72',
    refinement: null,
    scores: faintScores()
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'faint-anchor-not-exact-profile');
});

test('exact anchor with meaningful drift cannot use faint-anchor bypass', () => {
  const result = evaluateFaintAnchorSafety({
    confidence: 0.07,
    maxConfidence: 0.10,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-standard@4,0',
    refinement: { baseCandidateId: 'veo-portrait-1080-standard', dx: 4, dy: 0 },
    scores: faintScores()
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'faint-anchor-drift');
});

test('calibration must actually improve the faint anchor before auto clean', () => {
  const safety = evaluateFaintAnchorSafety({
    confidence: 0.06,
    maxConfidence: 0.081,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-standard',
    refinement: { baseCandidateId: 'veo-portrait-1080-standard', dx: 0, dy: 0 },
    scores: faintScores()
  });
  const accepted = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.08, baselineScore: 14.5, residualScore: 12.9 }
  });
  assert.equal(accepted.safe, true, JSON.stringify(accepted));

  const rejected = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.004, baselineScore: 14.5, residualScore: 14.46 }
  });
  assert.equal(rejected.safe, false);
});

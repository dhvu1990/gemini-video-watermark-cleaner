import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFaintAnchorCalibration, evaluateFaintAnchorSafety } from '../src/video/faintAnchorSafety.js';

function ultraFaintScores() {
  return Array.from({ length: 12 }, (_, i) => ({
    spatial: i < 9 ? 0.024 : 0.006,
    gradient: i < 9 ? 0.031 : 0.009,
    confidence: i < 9 ? 0.047 : 0.018
  }));
}

test('4 percent exact portrait anchor may enter calibration but is never directly trusted', () => {
  const result = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.052,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset@0,0',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 0, dy: 0 },
    scores: ultraFaintScores()
  });
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.ultraFaint, true);
  assert.equal(result.reason, 'ultra-faint-anchor-signature-match');
});

test('ultra-faint exact anchor requires stronger calibration improvement before safe cleanup', () => {
  const safety = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.052,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 0, dy: 0 },
    scores: ultraFaintScores()
  });

  const weak = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.022, baselineScore: 10, residualScore: 9.75 }
  });
  assert.equal(weak.safe, false);

  const strong = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.08, baselineScore: 10, residualScore: 8.9 }
  });
  assert.equal(strong.safe, true, JSON.stringify(strong));
  assert.equal(strong.reason, 'ultra-faint-anchor-calibrated-match');
});

test('sub-3.2 percent candidate remains blocked even at an exact anchor', () => {
  const result = evaluateFaintAnchorSafety({
    confidence: 0.028,
    maxConfidence: 0.05,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 0, dy: 0 },
    scores: ultraFaintScores()
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'faint-anchor-too-weak');
});

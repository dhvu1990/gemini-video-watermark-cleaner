import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFaintAnchorCalibration, evaluateFaintAnchorSafety } from '../src/video/faintAnchorSafety.js';

function borderlineScores() {
  return Array.from({ length: 12 }, (_, i) => ({
    spatial: i < 5 ? 0.018 : 0.007,
    gradient: i < 6 ? 0.024 : 0.010,
    confidence: i < 6 ? 0.043 : 0.018
  }));
}

test('4 percent exact anchor may enter probe calibration when normal signature gate is missed', () => {
  const safety = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.041,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset@0,0',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 0, dy: 0 },
    scores: borderlineScores()
  });
  assert.equal(safety.safe, true, JSON.stringify(safety));
  assert.equal(safety.probeOnly, true);
  assert.equal(safety.reason, 'ultra-faint-exact-anchor-probe');
});

test('probe-only anchor may promote after a clear low-gain cleanup improvement', () => {
  const safety = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.041,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 0, dy: 0 },
    scores: borderlineScores()
  });
  const result = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.05, baselineScore: 10, residualScore: 9.4, bodyGain: 0.24 }
  });
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.reason, 'faint-anchor-calibrated-match');
});

test('probe-only anchor requires plausible low gain and a strong cleanup win before promotion', () => {
  const safety = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.041,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 0, dy: 0 },
    scores: borderlineScores()
  });

  const badGain = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.12, baselineScore: 10, residualScore: 8.6, bodyGain: 0.72 }
  });
  assert.equal(badGain.safe, false);
  assert.equal(badGain.reason, 'faint-anchor-probe-gain-implausible');

  const promoted = evaluateFaintAnchorCalibration({
    safety,
    calibration: { improvement: 0.12, baselineScore: 10, residualScore: 8.6, bodyGain: 0.24 }
  });
  assert.equal(promoted.safe, true, JSON.stringify(promoted));
  assert.equal(promoted.reason, 'faint-anchor-calibrated-match');
  assert.equal(promoted.probeOnly, true);
});

test('probe path still rejects non-exact and drifting anchors', () => {
  const nonExact = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.045,
    minConfidence: 0.12,
    candidateId: 'veo-regional-72',
    refinement: { baseCandidateId: 'veo-regional-72', dx: 0, dy: 0 },
    scores: borderlineScores()
  });
  assert.equal(nonExact.safe, false);
  assert.equal(nonExact.reason, 'faint-anchor-not-exact-profile');

  const drift = evaluateFaintAnchorSafety({
    confidence: 0.04,
    maxConfidence: 0.045,
    minConfidence: 0.12,
    candidateId: 'veo-portrait-1080-inset',
    refinement: { baseCandidateId: 'veo-portrait-1080-inset', dx: 4, dy: 0 },
    scores: borderlineScores()
  });
  assert.equal(drift.safe, false);
  assert.equal(drift.reason, 'faint-anchor-drift');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFaintAnchorCalibration } from '../src/video/faintAnchorSafety.js';

const probeSafety = {
  safe: true,
  probeOnly: true,
  ultraFaint: true,
  id: 'veo-portrait-1080-inset',
  distance: 0,
  signature: { supportRatio: 0.5, spatialRatio: 0.4, gradientRatio: 0.5 }
};

test('probe promotion accepts a clear 5 percent low-gain cleanup win', () => {
  const result = evaluateFaintAnchorCalibration({
    safety: probeSafety,
    calibration: {
      improvement: 0.055,
      baselineScore: 10,
      residualScore: 9.4,
      bodyGain: 0.24
    }
  });
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.reason, 'faint-anchor-calibrated-match');
});

test('probe promotion still blocks marginal cleanup improvement', () => {
  const result = evaluateFaintAnchorCalibration({
    safety: probeSafety,
    calibration: {
      improvement: 0.03,
      baselineScore: 10,
      residualScore: 9.65,
      bodyGain: 0.24
    }
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'faint-anchor-probe-no-strong-improvement');
});

test('probe promotion still blocks implausibly strong body gain', () => {
  const result = evaluateFaintAnchorCalibration({
    safety: probeSafety,
    calibration: {
      improvement: 0.08,
      baselineScore: 10,
      residualScore: 9.0,
      bodyGain: 0.72
    }
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'faint-anchor-probe-gain-implausible');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStructuredDownstreamGuard } from '../src/video/structuredDownstreamGuard.js';

const lowGainCase = {
  ringAccepted: true,
  alignedBeforeScore: 1.720,
  alignedBaselineScore: 1.635,
  alignedSampleDensity: 0.048,
  alignedImprovement: 0.049,
  baselineGlobal: { total: 0.875, luma: 1.559, chroma: 0.456 },
  downstreamAccepted: true
};

test('structured downstream guard rolls back a low-gain accepted case when downstream final residuals worsen', () => {
  const state = evaluateStructuredDownstreamGuard({
    ...lowGainCase,
    finalAligned: { score: 1.690 },
    finalGlobal: { total: 0.888, luma: 1.586, chroma: 0.466 }
  });

  assert.equal(state.eligible, true);
  assert.equal(state.rollback, true);
  assert.equal(state.reason, 'downstream-safety-gate');
  assert.ok(state.failedGates.includes('aligned'));
  assert.ok(state.failedGates.includes('total'));
});

test('structured downstream guard keeps downstream output when the same low-gain case remains inside the safety envelope', () => {
  const state = evaluateStructuredDownstreamGuard({
    ...lowGainCase,
    finalAligned: { score: 1.620 },
    finalGlobal: { total: 0.872, luma: 1.552, chroma: 0.454 }
  });

  assert.equal(state.eligible, true);
  assert.equal(state.rollback, false);
  assert.equal(state.reason, 'safe');
  assert.deepEqual(state.failedGates, []);
});

test('structured downstream guard stays inactive for healthy ring improvement', () => {
  const state = evaluateStructuredDownstreamGuard({
    ...lowGainCase,
    alignedImprovement: 0.18,
    finalAligned: { score: 1.58 },
    finalGlobal: { total: 0.89, luma: 1.58, chroma: 0.46 }
  });

  assert.equal(state.eligible, false);
  assert.equal(state.rollback, false);
  assert.equal(state.reason, 'not-low-gain-eligible');
});

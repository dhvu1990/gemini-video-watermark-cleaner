import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRegionalSearchSafety } from '../src/video/detect.js';

function coherentScores() {
  return Array.from({ length: 12 }, () => ({ confidence: 0.30, spatial: 0.14, gradient: 0.24 }));
}

test('persistent decorative scene edge is review-only even with a 36 percent regional match', () => {
  const safety = evaluateRegionalSearchSafety({
    confidence: 0.36,
    voteRatio: 0.92,
    maxConfidence: 0.48,
    scores: coherentScores(),
    minConfidence: 0.12,
    sceneEdge: { protectRatio: 0.83, highRatio: 0.58, meanScore: 0.39, meanDensity: 0.047, samples: 12 },
    runnerUpConfidence: 0.19
  });
  assert.equal(safety.safe, false, JSON.stringify(safety));
  assert.equal(safety.reason, 'regional-persistent-scene-edge');
});

test('coherent regional watermark can pass when crossing-scene-edge evidence is low and it dominates alternatives', () => {
  const safety = evaluateRegionalSearchSafety({
    confidence: 0.31,
    voteRatio: 0.83,
    maxConfidence: 0.41,
    scores: coherentScores(),
    minConfidence: 0.12,
    sceneEdge: { protectRatio: 0.17, highRatio: 0.08, meanScore: 0.11, meanDensity: 0.009, samples: 12 },
    runnerUpConfidence: 0.20
  });
  assert.equal(safety.safe, true, JSON.stringify(safety));
  assert.equal(safety.reason, 'regional-signature-match');
});

test('near-tied distinct regional candidate remains review-only', () => {
  const safety = evaluateRegionalSearchSafety({
    confidence: 0.32,
    voteRatio: 0.83,
    maxConfidence: 0.43,
    scores: coherentScores(),
    minConfidence: 0.12,
    sceneEdge: { protectRatio: 0.08, highRatio: 0, meanScore: 0.07, meanDensity: 0.005, samples: 12 },
    runnerUpConfidence: 0.305
  });
  assert.equal(safety.safe, false, JSON.stringify(safety));
  assert.equal(safety.reason, 'regional-ambiguous-runner-up');
});

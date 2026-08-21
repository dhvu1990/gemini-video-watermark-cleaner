import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDetectionSafety } from '../src/video/detect.js';

test('medium-confidence match is blocked when refinement drifts too far from the catalog anchor', () => {
  const result = evaluateDetectionSafety({
    confidence: 0.34,
    minConfidence: 0.12,
    refinement: { dx: 8, dy: -7, size: 72, baseCandidateId: 'veo-portrait-1080-standard' }
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'unsafe-refinement-drift');
  assert.ok(result.refinement.distance > result.refinement.maxDistance);
});

test('low and medium-confidence matches remain auto-clean eligible when they stay on the known anchor', () => {
  for (const confidence of [0.20, 0.34, 0.40]) {
    const result = evaluateDetectionSafety({
      confidence,
      minConfidence: 0.12,
      refinement: { dx: 2, dy: -2, size: 72, baseCandidateId: 'veo-portrait-1080-inset' }
    });
    assert.equal(result.safe, true, JSON.stringify(result));
    assert.equal(result.reason, 'anchor-consistent-match');
  }
});

test('strong matches may tolerate a bounded exceptional refinement without being blocked', () => {
  const result = evaluateDetectionSafety({
    confidence: 0.61,
    minConfidence: 0.12,
    refinement: { dx: 6, dy: 5, size: 72, baseCandidateId: 'veo-portrait-1080-standard' }
  });
  assert.equal(result.safe, true, JSON.stringify(result));
  assert.equal(result.reason, 'strong-match-refinement');
});

test('confidence below the configured threshold is always blocked', () => {
  const result = evaluateDetectionSafety({
    confidence: 0.10,
    minConfidence: 0.12,
    refinement: { dx: 0, dy: 0, size: 72 }
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'low-confidence');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegionalSearchPositions, evaluateRegionalSearchSafety } from '../src/video/detect.js';

test('portrait regional search covers a broad bottom-right margin band without scanning the whole frame', () => {
  const positions = buildRegionalSearchPositions(1080, 1920, 72);
  assert.ok(positions.length > 100, positions.length);
  assert.ok(positions.some((p) => p.marginRight <= 36 && p.marginBottom <= 36));
  assert.ok(positions.some((p) => p.marginRight >= 180 && p.marginBottom >= 180));
  assert.ok(positions.every((p) => p.x > 700 && p.y > 1500));
});

test('signature-verified medium match can be accepted when multi-frame support is coherent', () => {
  const scores = Array.from({ length: 12 }, (_, i) => ({
    confidence: i < 9 ? 0.21 : 0.06,
    spatial: i < 9 ? 0.11 : 0.01,
    gradient: i < 9 ? 0.18 : 0.01
  }));
  const safety = evaluateRegionalSearchSafety({
    confidence: 0.22,
    voteRatio: 0.75,
    maxConfidence: 0.31,
    scores,
    minConfidence: 0.12
  });
  assert.equal(safety.safe, true, JSON.stringify(safety));
  assert.equal(safety.reason, 'regional-signature-match');
});

test('decorative one-frame geometry is rejected even if its peak score is high', () => {
  const scores = Array.from({ length: 12 }, (_, i) => ({
    confidence: i === 4 ? 0.42 : 0.04,
    spatial: i === 4 ? 0.25 : 0.005,
    gradient: i === 4 ? 0.31 : 0.004
  }));
  const safety = evaluateRegionalSearchSafety({
    confidence: 0.18,
    voteRatio: 0.20,
    maxConfidence: 0.42,
    scores,
    minConfidence: 0.12
  });
  assert.equal(safety.safe, false, JSON.stringify(safety));
});

test('weak 6 percent anchor-like candidate remains review-only', () => {
  const scores = Array.from({ length: 12 }, () => ({ confidence: 0.06, spatial: 0.03, gradient: 0.04 }));
  const safety = evaluateRegionalSearchSafety({
    confidence: 0.06,
    voteRatio: 0,
    maxConfidence: 0.08,
    scores,
    minConfidence: 0.12
  });
  assert.equal(safety.safe, false, JSON.stringify(safety));
  assert.equal(safety.reason, 'regional-low-confidence');
});

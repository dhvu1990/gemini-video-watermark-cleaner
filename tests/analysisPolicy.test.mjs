import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_SAMPLE_COUNT,
  QUICK_SCAN_FRACTION,
  QUICK_RESIDUAL_SCORE_LIMIT,
  quickConfidenceThreshold,
  shouldAcceptQuickDetection
} from '../src/video/analysisPolicy.js';

test('quick scan uses three frames over an early video window', () => {
  assert.equal(QUICK_SAMPLE_COUNT, 3);
  assert.equal(QUICK_SCAN_FRACTION, 0.18);
});

test('quick threshold stays stricter than normal detection', () => {
  assert.equal(quickConfidenceThreshold(0.12), 0.22);
  assert.equal(quickConfidenceThreshold(0.30), 0.38);
});

test('high-confidence quick detection is accepted when residual is controlled', () => {
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.86, voteRatio: 1, calibration: { residualScore: 13.5 } }, 0.12), true);
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.86, voteRatio: 2 / 3 }, 0.12), true);
});

test('high residual quick calibration expands to full scan', () => {
  assert.equal(QUICK_RESIDUAL_SCORE_LIMIT, 18);
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.86, voteRatio: 1, calibration: { residualScore: 22.817 } }, 0.12), false);
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.86, voteRatio: 1, calibration: { residualScore: 18 } }, 0.12), true);
});

test('weak or poorly voted quick detection expands to full scan', () => {
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.18, voteRatio: 1 }, 0.12), false);
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.82, voteRatio: 0.5 }, 0.12), false);
  assert.equal(shouldAcceptQuickDetection({ detected: false, confidence: 0.82, voteRatio: 1 }, 0.12), false);
});

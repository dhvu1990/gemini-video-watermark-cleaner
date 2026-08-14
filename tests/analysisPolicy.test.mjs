import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_SAMPLE_COUNT, quickConfidenceThreshold, shouldAcceptQuickDetection } from '../src/video/analysisPolicy.js';

test('quick scan uses four frames', () => {
  assert.equal(QUICK_SAMPLE_COUNT, 4);
});

test('quick threshold stays stricter than normal detection', () => {
  assert.equal(quickConfidenceThreshold(0.12), 0.20);
  assert.equal(quickConfidenceThreshold(0.30), 0.36);
});

test('high-confidence quick detection is accepted', () => {
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.86, voteRatio: 1 }, 0.12), true);
});

test('weak or poorly voted quick detection expands to full scan', () => {
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.16, voteRatio: 1 }, 0.12), false);
  assert.equal(shouldAcceptQuickDetection({ detected: true, confidence: 0.82, voteRatio: 0.25 }, 0.12), false);
  assert.equal(shouldAcceptQuickDetection({ detected: false, confidence: 0.82, voteRatio: 1 }, 0.12), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchBackgroundLabel,
  buildBatchDetectionView,
  humanizeBatchCandidate,
  sameBatchInspectOptions
} from '../src/batchPreviewModel.js';

test('batch candidate IDs are presented like the single-video auto-detect heading', () => {
  assert.equal(humanizeBatchCandidate('veo-portrait-720-relocated@1.2'), 'Portrait 720 Relocated');
  assert.equal(humanizeBatchCandidate('veo-landscape-1080-standard'), 'Landscape 1080 Standard');
});

test('batch detection view exposes match, ROI, background mode and risk flags', () => {
  const view = buildBatchDetectionView({
    detected: true,
    confidence: 0.432,
    candidateId: 'veo-portrait-720-relocated@2',
    position: { x: 551.7, y: 773.2, width: 72, height: 72 }
  }, {
    dualRingFinish: { smoothBackground: { mode: 'structured-fallback' } },
    antiStreak: { riskFlags: ['high-contrast-adjacency'] }
  });

  assert.equal(view.ready, true);
  assert.equal(view.matchPercent, 43);
  assert.match(view.title, /Portrait 720 Relocated \(43% match\)/);
  assert.deepEqual(view.position, { x: 552, y: 773, width: 72, height: 72 });
  assert.equal(view.riskFlags, 'high-contrast-adjacency');
});

test('batch background labels mirror the main preview cleanup mode', () => {
  assert.equal(batchBackgroundLabel({ dualRingFinish: { smoothBackground: { mode: 'smooth-rebuild' } } }), 'Smooth background rebuild');
  assert.equal(batchBackgroundLabel({ dualRingFinish: { smoothBackground: { mode: 'empty-hard-rebuild' } } }), 'Safe empty-zone hard suppression');
  assert.equal(batchBackgroundLabel(null), 'Structured-background fallback');
});

test('cached batch inspect results are reused only while relevant inspect settings match', () => {
  const options = { sampleCount: 12, minConfidence: 0.12, edgePolish: 0.35, scanFraction: 1 };
  assert.equal(sameBatchInspectOptions(options, { ...options }), true);
  assert.equal(sameBatchInspectOptions(options, { ...options, sampleCount: 18 }), false);
  assert.equal(sameBatchInspectOptions(null, options), false);
});

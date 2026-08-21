import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInspectResultForWorker } from '../src/video/inspectResultBridge.js';

function roi(values) {
  return { width: 2, height: 2, data: new Uint8ClampedArray(values) };
}

test('review-only detection exposes no synthetic cleaned pixels', () => {
  const original = roi([
    10,20,30,255, 40,50,60,255,
    70,80,90,255, 100,110,120,255
  ]);
  const cleaned = roi([
    200,10,10,255, 200,10,10,255,
    200,10,10,255, 200,10,10,255
  ]);
  const alphaMap = new Float32Array([0.2, 0.2, 0.2, 0.2]);
  const result = prepareInspectResultForWorker({
    detection: { detected: false, safeToClean: false, reason: 'low-confidence' },
    preview: { original, cleaned },
    internalDetection: { alphaMap }
  });

  assert.equal(result.preview.previewSuppressed, true);
  assert.equal(result.preview.suppressionReason, 'low-confidence');
  assert.deepEqual([...result.preview.cleaned.data], [...original.data]);
  assert.notStrictEqual(result.preview.cleaned.data, original.data);
  assert.ok(result.preview.antiStreak.riskFlags.includes('unsafe-preview-suppressed'));
});

test('safe detection preserves the actual cleaned preview', () => {
  const original = roi(new Array(16).fill(80));
  const cleaned = roi(new Array(16).fill(60));
  const alphaMap = new Float32Array([0.2, 0.2, 0.2, 0.2]);
  const result = prepareInspectResultForWorker({
    detection: { detected: true, safeToClean: true, reason: 'multi-frame-match' },
    preview: { original, cleaned },
    internalDetection: { alphaMap }
  });

  assert.equal(result.preview.previewSuppressed, undefined);
  assert.deepEqual([...result.preview.cleaned.data], [...cleaned.data]);
});

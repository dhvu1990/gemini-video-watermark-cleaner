import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInspectResultForWorker } from '../src/video/inspectResultBridge.js';

test('inspect worker bridge retains only alpha map required by preview footprint diagnostics', () => {
  const alphaMap = new Float32Array([0, 0.1, 0.25, 0.5]);
  const result = prepareInspectResultForWorker({
    metadata: { width: 1080, height: 1920 },
    detection: { detected: true, confidence: 0.9 },
    preview: { cleaned: { width: 2, height: 2, data: new Uint8ClampedArray(16) } },
    internalDetection: {
      alphaMap,
      frameScores: [{ score: 123 }],
      confidence: 0.9,
      privateMarker: 'must-not-cross-worker'
    }
  });

  assert.equal(result.internalDetection.alphaMap, alphaMap);
  assert.deepEqual(Object.keys(result.internalDetection), ['alphaMap']);
  assert.equal(result.internalDetection.frameScores, undefined);
  assert.equal(result.internalDetection.privateMarker, undefined);
  assert.equal(result.detection.detected, true);
  assert.ok(result.preview.cleaned);
});

test('inspect worker bridge still strips internal detection when diagnostic alpha is unavailable', () => {
  const result = prepareInspectResultForWorker({
    metadata: { width: 10, height: 20 },
    internalDetection: { confidence: 0.5, frameScores: [1, 2, 3] }
  });

  assert.equal(result.internalDetection, undefined);
  assert.deepEqual(result.metadata, { width: 10, height: 20 });
});

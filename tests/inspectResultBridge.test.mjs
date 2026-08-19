import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInspectResultForWorker } from '../src/video/inspectResultBridge.js';

function makeHighContrastPreview(width = 48, height = 48) {
  const data = new Uint8ClampedArray(width * height * 4);
  const alphaMap = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const bright = x >= 14 && x <= 18 && y >= 7 && y < 41;
      const value = bright ? 244 : 72;
      data[i] = value; data[i + 1] = bright ? 244 : 56; data[i + 2] = bright ? 240 : 44; data[i + 3] = 255;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      alphaMap[p] = d <= 8 ? 0.34 : (d <= 10 ? 0.10 : 0);
    }
  }
  return { cleaned: { width, height, data }, alphaMap };
}

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
  assert.ok(result.preview.antiStreak?.structured?.highContrastAdjacency);
});

test('inspect worker bridge attaches provisional high-contrast adjacency telemetry without exposing private detection state', () => {
  const fixture = makeHighContrastPreview();
  const result = prepareInspectResultForWorker({
    preview: {
      cleaned: fixture.cleaned,
      antiStreak: { structured: { attempted: true }, riskFlags: ['existing-risk'] }
    },
    internalDetection: { alphaMap: fixture.alphaMap, privateMarker: 'hidden' }
  });

  const adjacency = result.preview.antiStreak.structured.highContrastAdjacency;
  assert.ok(adjacency);
  assert.equal(adjacency.provisional, true);
  assert.ok(adjacency.candidateSamples >= 20);
  assert.ok(adjacency.edgeSamples > 0);
  assert.ok(adjacency.meanContrast > 5);
  assert.ok(['low', 'medium', 'high'].includes(adjacency.level));
  assert.deepEqual(Object.keys(result.internalDetection), ['alphaMap']);
  assert.equal(result.internalDetection.privateMarker, undefined);
  assert.ok(result.preview.antiStreak.riskFlags.includes('existing-risk'));
  if (adjacency.level === 'high') assert.ok(result.preview.antiStreak.riskFlags.includes('high-contrast-adjacency'));
});

test('inspect worker bridge still strips internal detection when diagnostic alpha is unavailable', () => {
  const result = prepareInspectResultForWorker({
    metadata: { width: 10, height: 20 },
    internalDetection: { confidence: 0.5, frameScores: [1, 2, 3] }
  });

  assert.equal(result.internalDetection, undefined);
  assert.deepEqual(result.metadata, { width: 10, height: 20 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVeoWordmarkAlphaMap, resolveVeoWordmarkCandidates,
  isVeoWordmarkCandidate, repairVeoWordmarkPaddedRegion
} from '../src/video/veoWordmark.js';
import { detectVeoWordmarkFromFrames } from '../src/video/detect.js';

function frame(width, height, position = null, alphaMap = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const z = 52 + Math.round(14 * x / width) + Math.round(7 * y / height);
    data[i] = z + 22; data[i + 1] = z - 4; data[i + 2] = z - 15; data[i + 3] = 255;
  }
  if (position && alphaMap) {
    for (let y = 0; y < position.size; y++) for (let x = 0; x < position.size; x++) {
      const a = alphaMap[y * position.size + x] || 0;
      const i = ((y + position.y) * width + position.x + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * (1 - a) + 255 * a);
    }
  }
  return { width, height, data };
}

test('v1.0.130 wordmark stencil is isolated, square and nonzero', () => {
  const map = buildVeoWordmarkAlphaMap(60);
  assert.equal(map.length, 3600);
  assert.ok(map.some((a) => a > 0.2));
  assert.ok(map.every((a) => a >= 0 && a < 0.8));
  assert.equal(isVeoWordmarkCandidate('veo-wordmark-left-60'), true);
  assert.equal(isVeoWordmarkCandidate('veo-portrait-1080-inset'), false);
});

test('v1.0.130 candidate positions remain in the lower corners', () => {
  for (const [w, h] of [[1280, 720], [720, 1280], [1920, 1080]]) {
    const candidates = resolveVeoWordmarkCandidates(w, h);
    assert.ok(candidates.some((c) => c.id.includes('left')));
    assert.ok(candidates.some((c) => c.id.includes('right')));
    assert.ok(candidates.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.size <= w && c.y + c.size <= h));
  }
});

test('v1.0.130 detector identifies repeated white wordmark on changing backgrounds', async () => {
  const width = 640, height = 360;
  const position = resolveVeoWordmarkCandidates(width, height).find((c) => c.id.startsWith('veo-wordmark-right-'));
  assert.ok(position);
  const alpha = buildVeoWordmarkAlphaMap(position.size);
  const frames = [0, 1, 2].map((i) => ({
    timestamp: i,
    imageData: frame(width, height, position, alpha)
  }));
  const detection = await detectVeoWordmarkFromFrames({ frames, width, height });
  assert.equal(detection?.detected, true);
  assert.equal(detection.position.width, position.size);
});

test('v1.0.130 wordmark detector avoids clean footage and single-frame evidence', async () => {
  const width = 640, height = 360;
  const imageData = frame(width, height);
  assert.equal(await detectVeoWordmarkFromFrames({ frames: [{ imageData }], width, height }), null);
  const clean = await detectVeoWordmarkFromFrames({
    frames: [0, 1, 2].map((timestamp) => ({ timestamp, imageData: frame(width, height) })),
    width, height
  });
  assert.equal(clean, null);
});

test('v1.0.130 dedicated repair never modifies a clean zero-alpha ROI', () => {
  const original = frame(60, 60);
  const repaired = repairVeoWordmarkPaddedRegion(original, {
    offsetX: 0, offsetY: 0, width: 60, height: 60
  }, new Float32Array(3600), 1);
  assert.deepEqual(repaired.cleaned.data, original.data);
  assert.equal(repaired.veoWordmark.correctedPixels, 0);
});

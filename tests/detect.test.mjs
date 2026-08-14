import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideoWatermarkCandidates } from '../src/video/catalog.js';
import { detectVideoWatermarkFromFrames } from '../src/video/detect.js';
import { getVideoAlphaMap } from '../src/video/alpha.js';

function createFrame(width, height, phase = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const texture = ((x * 7 + y * 11 + phase * 13) % 17) - 8;
      data[i] = 72 + texture;
      data[i + 1] = 88 + texture;
      data[i + 2] = 103 + texture;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function overlay(frame, position, alpha) {
  for (let y = 0; y < position.size; y++) {
    for (let x = 0; x < position.size; x++) {
      const a = alpha[y * position.size + x] || 0;
      const i = ((position.y + y) * frame.width + position.x + x) * 4;
      for (let c = 0; c < 3; c++) frame.data[i + c] = Math.round(frame.data[i + c] * (1 - a) + 255 * a);
    }
  }
}

test('multi-frame detector finds a synthetic 720p standard watermark', async () => {
  const width = 1280;
  const height = 720;
  const position = resolveVideoWatermarkCandidates(width, height).find((item) => item.id === 'veo-720p-standard');
  assert.ok(position);
  const alpha = await getVideoAlphaMap(position.size);
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const imageData = createFrame(width, height, i);
    overlay(imageData, position, alpha);
    frames.push({ timestamp: i, imageData });
  }

  const result = await detectVideoWatermarkFromFrames({ frames, width, height, minConfidence: 0.08 });
  assert.equal(result.detected, true);
  assert.ok(Math.abs(result.position.x - position.x) <= 4);
  assert.ok(Math.abs(result.position.y - position.y) <= 4);
  assert.equal(result.position.width, position.size);
  assert.ok(result.confidence >= 0.08);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from '../src/video/sceneEdgeProtection.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 14) alpha[y * width + x] = 0.52;
      else if (d <= 17) alpha[y * width + x] = 0.22;
      else if (d <= 20) alpha[y * width + x] = 0.07;
      else if (d <= 22) alpha[y * width + x] = 0.018;
    }
  }
  return alpha;
}

test('crossing scene-edge risk protects a real diagonal line through the watermark footprint', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const src = makeImage(width, height, (x, y) => {
    const base = [62 + x * 0.20, 142 + y * 0.16, 205 + x * 0.08];
    const line = Math.abs(y - (0.58 * x + 16)) <= 1.4;
    return line ? [32, 48, 64] : base;
  });
  const metric = measureCrossingSceneEdgeRisk(src, alpha);
  assert.notEqual(metric.level, 'insufficient', JSON.stringify(metric));
  assert.equal(metric.protect, true, JSON.stringify(metric));
  assert.ok(metric.sceneEdgeSamples > 0, JSON.stringify(metric));
  assert.ok(metric.continuousSamples > 0, JSON.stringify(metric));
});

test('plain smooth gradient does not trigger crossing scene-edge protection', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const src = makeImage(width, height, (x, y) => [
    66 + x * 0.24 + y * 0.04,
    140 + x * 0.12 + y * 0.18,
    206 + x * 0.08 - y * 0.04
  ]);
  const metric = measureCrossingSceneEdgeRisk(src, alpha);
  assert.equal(metric.protect, false, JSON.stringify(metric));
  assert.ok(metric.score < 0.34, JSON.stringify(metric));
});

test('per-pixel protection is stronger on a scene edge boundary than on nearby smooth pixels', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const src = makeImage(width, height, (x, y) => {
    const base = 124 + x * 0.18 + y * 0.10;
    const line = Math.abs(y - (0.50 * x + 20)) <= 1.2;
    return line ? [42, 50, 58] : [base, base + 18, base + 34];
  });
  let strongest = null;
  for (let y = 36; y <= 44; y++) {
    for (let x = 34; x <= 46; x++) {
      const sample = sceneEdgeProtectionAt(src, alpha, x, y);
      if (!strongest || sample.weight > strongest.weight) strongest = { ...sample, x, y };
    }
  }
  const smooth = sceneEdgeProtectionAt(src, alpha, 34, 44);
  assert.ok(strongest.weight > 0.20, JSON.stringify({ strongest, smooth }));
  assert.ok(strongest.weight > smooth.weight, JSON.stringify({ strongest, smooth }));
});

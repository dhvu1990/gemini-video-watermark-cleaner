import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHighContrastAdjacency,
  measureHighContrastAdjacency
} from '../src/video/highContrastAdjacencyDiagnostics.js';

function makeImage(width, height, rgb = [82, 63, 51]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { width, height, data };
}
function setPixel(image, x, y, rgb) {
  const i = (y * image.width + x) * 4;
  image.data[i] = rgb[0]; image.data[i + 1] = rgb[1]; image.data[i + 2] = rgb[2]; image.data[i + 3] = 255;
}
function diamondAlpha(width, height, radius = 10) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      alpha[y * width + x] = d <= radius - 2 ? 0.34 : (d <= radius ? 0.10 : 0);
    }
  }
  return alpha;
}

test('smooth background reports negligible high-contrast adjacency', () => {
  const image = makeImage(48, 48);
  const alpha = diamondAlpha(48, 48);
  const metric = measureHighContrastAdjacency(image, alpha);
  assert.equal(metric.edgeSamples, 0);
  assert.equal(metric.straddleSamples, 0);
  assert.ok(metric.score < 0.02);
});

test('glyph-like bright scene stroke crossing the watermark neighborhood raises adjacency evidence', () => {
  const image = makeImage(48, 48);
  const alpha = diamondAlpha(48, 48);
  for (let y = 7; y < 41; y++) {
    for (let x = 14; x <= 18; x++) setPixel(image, x, y, [242, 242, 238]);
  }
  const metric = measureHighContrastAdjacency(image, alpha);
  assert.ok(metric.edgeSamples > 0);
  assert.ok(metric.meanContrast > 5);
  assert.ok(metric.edgeDensity > 0.015);
  assert.ok(metric.score > 0.10);
});

test('strong edge far away from the watermark neighborhood is ignored', () => {
  const image = makeImage(48, 48);
  const alpha = diamondAlpha(48, 48);
  for (let y = 2; y < 46; y++) {
    for (let x = 2; x <= 4; x++) setPixel(image, x, y, [245, 245, 245]);
  }
  const metric = measureHighContrastAdjacency(image, alpha);
  assert.ok(metric.score < 0.05);
  assert.ok(metric.edgeDensity < 0.02);
});

test('provisional classifier separates high, medium and insufficient telemetry', () => {
  const high = classifyHighContrastAdjacency({ score: 0.72, edgeDensity: 0.12, straddleDensity: 0.028, meanContrast: 11, candidateSamples: 120 });
  const medium = classifyHighContrastAdjacency({ score: 0.38, edgeDensity: 0.05, straddleDensity: 0.009, meanContrast: 6, candidateSamples: 120 });
  const low = classifyHighContrastAdjacency({ score: 0.12, edgeDensity: 0.01, straddleDensity: 0.001, meanContrast: 2.5, candidateSamples: 120 });
  const insufficient = classifyHighContrastAdjacency({ score: 0.9, edgeDensity: 0.5, straddleDensity: 0.2, meanContrast: 20, candidateSamples: 8 });
  assert.equal(high.level, 'high');
  assert.equal(medium.level, 'medium');
  assert.equal(low.level, 'low');
  assert.equal(insufficient.level, 'insufficient');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDarkUnderflowGuard, measureDarkUnderflow } from '../src/video/darkUnderflowGuard.js';
import { inverseAlphaRestore } from '../src/video/restore.js';

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

function diamondAlpha(width, height, body = 0.48) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 10) alpha[y * width + x] = body;
      else if (d <= 13) alpha[y * width + x] = 0.22;
      else if (d <= 16) alpha[y * width + x] = 0.07;
    }
  }
  return alpha;
}

function compositeWhite(base, alphaMap) {
  const data = new Uint8ClampedArray(base.data);
  for (let p = 0; p < alphaMap.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(base.data[i + c] * (1 - a) + 255 * a);
  }
  return { width: base.width, height: base.height, data };
}

function meanLuma(image, alphaMap, minAlpha = 0.30) {
  let sum = 0, count = 0;
  for (let p = 0; p < alphaMap.length; p++) {
    if ((alphaMap[p] || 0) < minAlpha) continue;
    const i = p * 4;
    sum += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
    count++;
  }
  return count ? sum / count : 0;
}

test('dark underflow guard lifts gain-induced black collapse back toward a dark background', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height, 0.48);
  const base = makeImage(width, height, (x, y) => [27 + x * 0.04, 29 + y * 0.03, 31 + x * 0.02]);
  const composite = compositeWhite(base, alpha);

  const raw = new Uint8ClampedArray(composite.data);
  for (let p = 0; p < alpha.length; p++) {
    const a = Math.min(0.99, (alpha[p] || 0) * 1.35);
    if (a <= 0.002) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) raw[i + c] = Math.max(0, Math.min(255, Math.round((composite.data[i + c] - a * 255) / (1 - a))));
  }
  const collapsed = { width, height, data: raw };
  const before = measureDarkUnderflow(collapsed, composite, alpha);
  const guarded = applyDarkUnderflowGuard(collapsed, composite, alpha);
  const after = measureDarkUnderflow(guarded, composite, alpha);

  assert.ok(before.underflowPixels > 20, JSON.stringify(before));
  assert.equal(guarded.darkUnderflowGuard.accepted, true, JSON.stringify(guarded.darkUnderflowGuard));
  assert.ok(after.underflowPixels <= before.underflowPixels, JSON.stringify({ before, after }));
  assert.ok(after.meanCollapse < before.meanCollapse * 0.40, JSON.stringify({ before, after }));
  assert.ok(meanLuma(guarded, alpha) > meanLuma(collapsed, alpha) + 6);
});

test('inverseAlphaRestore prevents dark collapse before the secondary underflow guard is needed', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height, 0.48);
  const base = makeImage(width, height, () => [30, 31, 33]);
  const composite = compositeWhite(base, alpha);
  const result = inverseAlphaRestore(composite, alpha, 1.35);

  assert.equal(result.adaptiveAlphaUnderflowCap?.attempted, true, JSON.stringify(result.adaptiveAlphaUnderflowCap));
  assert.ok((result.adaptiveAlphaUnderflowCap?.alphaCappedPixels || 0) > 0, JSON.stringify(result.adaptiveAlphaUnderflowCap));
  assert.ok((result.adaptiveAlphaUnderflowCap?.blackPixelsPrevented || 0) > 0, JSON.stringify(result.adaptiveAlphaUnderflowCap));
  assert.ok(result.darkUnderflowGuard, 'secondary dark-underflow diagnostics should remain available');
  assert.ok(meanLuma(result, alpha) > 10);
});

test('true near-black clean background is not artificially lifted', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height, 0.44);
  const original = makeImage(width, height, () => [3, 4, 5]);
  const restored = makeImage(width, height, () => [2, 3, 4]);
  const result = applyDarkUnderflowGuard(restored, original, alpha);
  assert.equal(result.darkUnderflowGuard.attempted, false, JSON.stringify(result.darkUnderflowGuard));
  assert.deepEqual(Array.from(result.data), Array.from(restored.data));
});

test('strong real boundary through the footprint is not flattened by the guard', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height, 0.50);
  const original = makeImage(width, height, (x) => x < width / 2 ? [28, 30, 34] : [82, 84, 88]);
  const restored = makeImage(width, height, (x) => x < width / 2 ? [4, 5, 6] : [58, 60, 64]);
  const result = applyDarkUnderflowGuard(restored, original, alpha);
  let left = 0, right = 0, leftN = 0, rightN = 0;
  for (let y = 26; y <= 46; y++) {
    for (let x = 28; x <= 43; x++) {
      const p = y * width + x;
      if ((alpha[p] || 0) < 0.30) continue;
      const i = p * 4;
      const lum = 0.2126 * result.data[i] + 0.7152 * result.data[i + 1] + 0.0722 * result.data[i + 2];
      if (x < width / 2) { left += lum; leftN++; } else { right += lum; rightN++; }
    }
  }
  assert.ok(right / rightN - left / leftN > 35, JSON.stringify({ left: left / leftN, right: right / rightN, guard: result.darkUnderflowGuard }));
});

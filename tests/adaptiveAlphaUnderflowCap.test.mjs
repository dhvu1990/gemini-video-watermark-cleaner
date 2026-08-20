import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveAlphaUnderflowCap } from '../src/video/adaptiveAlphaUnderflowCap.js';
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

function diamondAlpha(width, height, body = 0.50) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
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
    const i = p * 4;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(base.data[i + c] * (1 - a) + 255 * a);
  }
  return { width: base.width, height: base.height, data };
}

function coreMeanLuma(image, alphaMap) {
  let sum = 0, n = 0;
  for (let p = 0; p < alphaMap.length; p++) {
    if ((alphaMap[p] || 0) < 0.30) continue;
    const i = p * 4;
    sum += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
    n++;
  }
  return n ? sum / n : 0;
}

test('adaptive alpha cap prevents gain-induced black collapse before inverse clamp', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height, 0.50);
  const base = makeImage(width, height, (x, y) => [22 + x * 0.05, 24 + y * 0.04, 28 + x * 0.03]);
  const composite = compositeWhite(base, alpha);
  const cap = buildAdaptiveAlphaUnderflowCap(composite, alpha, 1.34);
  assert.ok(cap.diagnostics.alphaCappedPixels > 20, JSON.stringify(cap.diagnostics));
  assert.ok(cap.diagnostics.cappedInverseBlackPixels < cap.diagnostics.rawInverseBlackPixels, JSON.stringify(cap.diagnostics));
  assert.ok(cap.diagnostics.coreMeanLumaCapped > cap.diagnostics.coreMeanLumaRaw + 4, JSON.stringify(cap.diagnostics));
});

test('inverseAlphaRestore exposes cap telemetry and keeps dark core above catastrophic black', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height, 0.50);
  const base = makeImage(width, height, () => [25, 27, 30]);
  const composite = compositeWhite(base, alpha);
  const restored = inverseAlphaRestore(composite, alpha, 1.34);
  assert.ok(restored.adaptiveAlphaUnderflowCap?.attempted, JSON.stringify(restored.adaptiveAlphaUnderflowCap));
  assert.ok(restored.adaptiveAlphaUnderflowCap?.alphaCappedPixels > 0, JSON.stringify(restored.adaptiveAlphaUnderflowCap));
  assert.ok(coreMeanLuma(restored, alpha) > 12, JSON.stringify(restored.adaptiveAlphaUnderflowCap));
});

test('true near-black clean ring does not force an artificial lift', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height, 0.42);
  const base = makeImage(width, height, () => [3, 4, 5]);
  const composite = compositeWhite(base, alpha);
  const cap = buildAdaptiveAlphaUnderflowCap(composite, alpha, 1.0);
  assert.ok(cap.diagnostics.meanLocalFloor <= 6 || cap.diagnostics.alphaCappedPixels === 0, JSON.stringify(cap.diagnostics));
  assert.ok(cap.diagnostics.coreMeanLumaCapped <= cap.diagnostics.coreMeanLumaRaw + 3, JSON.stringify(cap.diagnostics));
});

test('mixed dark structure keeps adaptive cap bounded rather than flattening the footprint', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height, 0.48);
  const base = makeImage(width, height, (x, y) => {
    const stripe = ((x + Math.floor(y / 4)) % 10) < 3;
    return stripe ? [16, 18, 21] : [42, 45, 49];
  });
  const composite = compositeWhite(base, alpha);
  const cap = buildAdaptiveAlphaUnderflowCap(composite, alpha, 1.28);
  assert.ok(cap.diagnostics.alphaCappedPixels < cap.diagnostics.attemptedPixels * 0.9, JSON.stringify(cap.diagnostics));
  assert.ok(cap.diagnostics.meanRawAlpha - cap.diagnostics.meanEffectiveAlpha < 0.24 || cap.diagnostics.alphaCappedPixels === 0, JSON.stringify(cap.diagnostics));
});

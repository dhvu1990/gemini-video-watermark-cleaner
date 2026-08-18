import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPaddedRegion } from '../src/video/engine.js';
import { applyEdgePolish, inverseAlphaRestore } from '../src/video/restore.js';
import {
  applyPaddedTextureRepair,
  cropRegion,
  embedAlphaMap,
  pasteRegion
} from '../src/video/textureRepair.js';
import { applyNormalEdgeBridge } from '../src/video/edgeBridge.js';
import { applyDualRingLumaFinish } from '../src/video/dualRingFinish.js';

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function innerAlpha(size) {
  const alpha = new Float32Array(size * size);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.abs(x - center) + Math.abs(y - center);
      if (d <= 3) alpha[y * size + x] = 0.52;
      else if (d <= 5) alpha[y * size + x] = 0.16;
      else if (d <= 6) alpha[y * size + x] = 0.045;
    }
  }
  return alpha;
}

test('anti-streak runtime summary is diagnostic-only and preserves the existing no-history pixel pipeline', () => {
  const width = 36;
  const height = 36;
  const size = 13;
  const inner = { offsetX: 11, offsetY: 11, width: size, height: size };
  const alpha = innerAlpha(size);
  const padded = image(width, height, (x, y) => [
    62 + x * 2,
    86 + y,
    118 + ((x * 3 + y * 5) % 11)
  ]);

  const original = cropRegion(padded, inner.offsetX, inner.offsetY, inner.width, inner.height);
  let cleaned = inverseAlphaRestore(original, alpha, 1);
  cleaned = applyEdgePolish(cleaned, alpha, 0.35);
  const paddedAlpha = embedAlphaMap(alpha, inner.width, inner.height, padded.width, padded.height, inner.offsetX, inner.offsetY);
  let reference = pasteRegion(padded, cleaned, inner.offsetX, inner.offsetY);
  reference = applyPaddedTextureRepair(reference, paddedAlpha, 0.68);
  reference = applyNormalEdgeBridge(reference, paddedAlpha, 0.90);
  reference = applyDualRingLumaFinish(reference, paddedAlpha, { strength: 0.56 });

  const result = repairPaddedRegion(padded, inner, alpha, 1, 0.35, [], false);
  const referenceCleaned = cropRegion(reference, inner.offsetX, inner.offsetY, inner.width, inner.height);

  assert.deepEqual(Array.from(result.repairedPadded.data), Array.from(reference.data));
  assert.deepEqual(Array.from(result.cleaned.data), Array.from(referenceCleaned.data));
  assert.ok(result.antiStreakDiagnostics);
  assert.equal(result.antiStreakDiagnostics.temporalDonor.attempted, false);
  assert.equal(result.antiStreakDiagnostics.atlas.donorCount, 0);
  assert.ok(Array.isArray(result.antiStreakDiagnostics.riskFlags));
  assert.equal(typeof result.antiStreakDiagnostics.structured.attempted, 'boolean');
});

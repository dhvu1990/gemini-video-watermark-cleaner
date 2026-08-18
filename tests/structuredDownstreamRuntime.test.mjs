import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDualRingLumaFinish } from '../src/video/dualRingFinish.js';

function image(width, height, fn) {
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
      if (d <= 7) alpha[y * width + x] = 0.56;
      else if (d <= 10) alpha[y * width + x] = 0.22;
      else if (d <= 12) alpha[y * width + x] = 0.055;
    }
  }
  return alpha;
}

test('structured runtime exposes final downstream guard diagnostics without affecting non-eligible cases', () => {
  const width = 56, height = 56;
  const alpha = diamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p] || 0;
    const base = [78 + x, 94 + Math.floor(y * 0.8), 112 + ((x + y) % 7)];
    const ghost = a > 0.05 ? Math.round(a * 20) : 0;
    return [base[0] + ghost, base[1] + ghost, base[2] + ghost];
  });

  const result = applyDualRingLumaFinish(source, alpha, {
    smoothBackground: false,
    structuredRing: true,
    structuredRingStrength: 0.50
  });

  assert.ok(result.structuredRing);
  assert.ok(result.structuredRing.downstreamGuard);
  assert.equal(typeof result.structuredRing.downstreamGuard.eligible, 'boolean');
  assert.equal(typeof result.structuredRing.downstreamGuard.rollback, 'boolean');
  assert.ok(result.structuredRingDiagnostics?.downstreamGuard);
  assert.equal(
    result.structuredRingDiagnostics.alignedAfterScore,
    result.structuredRing.downstreamGuard.rollback
      ? result.structuredRing.downstreamGuard.baselineAligned.score
      : result.structuredRing.downstreamGuard.finalAligned.score
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShapeGhostSuppression } from '../src/video/shapeGhostSuppress.js';

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

function alpha(width, height) {
  const out = new Float32Array(width * height);
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d <= 11) out[y * width + x] = Math.max(0.08, 0.62 * (1 - d / 15));
    else if (d <= 14) out[y * width + x] = 0.03 * (15 - d);
  }
  return out;
}

test('dark aligned ghost cleanup may boost confidence but still obeys global residual safety gates', () => {
  const width = 56, height = 56;
  const a = alpha(width, height);
  const source = image(width, height, (x, y) => {
    const p = y * width + x;
    const base = x + y < 56 ? 34 : 62;
    const ghost = a[p] > 0.08 ? Math.round(5 + a[p] * 22) : 0;
    return [base + ghost, base + 5 + ghost, base + 9 + ghost];
  });
  const result = applyShapeGhostSuppression(source, a);
  const info = result.shapeGhost;
  assert.equal(info.attempted, true);
  assert.ok(info.candidatePixels > 0);
  assert.ok(info.candidateDarkBoostedPixels >= 0);
  if (info.accepted) {
    assert.ok(info.after.score < info.before.score);
    assert.ok(info.outerAfter.total <= info.outerBefore.total * 1.006 + 1e-9);
  }
});

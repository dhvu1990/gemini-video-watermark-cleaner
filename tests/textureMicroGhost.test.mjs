import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShapeGhostSuppression, measureShapeGhostResidual } from '../src/video/shapeGhostSuppress.js';

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
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= 12) alpha[y * width + x] = Math.max(0.05, 0.58 * (1 - d / 15));
      else if (d <= 15) alpha[y * width + x] = Math.max(0, 0.045 * (16 - d));
    }
  }
  return alpha;
}

function meanDelta(a, b) {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (a.width * a.height * 3);
}

test('faint smooth-background diamond can use the micro-ghost path without bypassing safety gates', () => {
  const width = 56, height = 56;
  const alpha = diamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p];
    const base = 208 + Math.round(x * 0.08 + y * 0.05);
    const ghost = a > 0.07 ? Math.round(a * 5.5) : 0;
    return [base + ghost, base + ghost, base + ghost];
  });
  const before = measureShapeGhostResidual(source, alpha);
  const result = applyShapeGhostSuppression(source, alpha, { microMinScore: 0.20 });
  const info = result.shapeGhost;
  assert.ok(info.field);
  if (info.microEligible) assert.equal(info.attempted, true);
  if (info.accepted) {
    assert.ok(info.after.score < before.score);
    assert.ok(info.outerAfter.total <= info.outerBefore.total * 1.006 + 1e-9);
  } else {
    assert.equal(meanDelta(result, source), 0);
  }
});

test('textured background only restores bounded detail when the final residual gates still pass', () => {
  const width = 56, height = 56;
  const alpha = diamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p];
    const weave = ((x * 3 + y * 5) % 9) - 4;
    const base = 118 + Math.round(x * 0.35) + weave * 3;
    const ghost = a > 0.07 ? Math.round(a * 18) : 0;
    return [base + ghost, base + ghost + 7, base + ghost + 13];
  });
  const result = applyShapeGhostSuppression(source, alpha, { textureRestore: 0.50 });
  const info = result.shapeGhost;
  assert.ok(info.field);
  assert.equal(typeof info.candidateTextureRestoredPixels, 'number');
  if (info.accepted) {
    assert.ok(info.after.score < info.before.score);
    assert.ok(info.outerAfter.total <= info.outerBefore.total * 1.006 + 1e-9);
  } else {
    assert.equal(meanDelta(result, source), 0);
  }
});

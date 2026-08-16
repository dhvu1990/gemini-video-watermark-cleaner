import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredConsensusRepair } from '../src/video/structuredConsensusRepair.js';

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
      if (d <= 7) alpha[y * width + x] = 0.52;
      else if (d <= 10) alpha[y * width + x] = 0.20;
      else if (d <= 12) alpha[y * width + x] = 0.05;
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

test('structured consensus candidate never accepts a worse post-clean residual', () => {
  const width = 48, height = 48;
  const alpha = diamondAlpha(width, height);
  const damaged = image(width, height, (x, y) => {
    const p = y * width + x;
    const base = y < 24 ? [42, 55, 70] : [220, 126, 32];
    const a = alpha[p];
    const ghost = a > 0 ? Math.round((0.60 - Math.min(0.60, a)) * 24) : 0;
    return [base[0] + ghost, base[1] + ghost, base[2] + ghost];
  });
  const result = applyStructuredConsensusRepair(damaged, alpha);
  const info = result.structuredConsensus;
  assert.equal(info.attempted, true);
  if (info.accepted) {
    assert.ok(info.after.total <= info.before.total * 0.997 + 1e-9);
    assert.ok(info.after.luma <= info.before.luma * 1.008 + 1e-9);
    assert.ok(info.after.chroma <= info.before.chroma * 1.008 + 1e-9);
    assert.ok(info.correctedPixels > 0);
    assert.ok(info.meanDirectionalSupport >= 2);
  } else {
    assert.equal(meanDelta(result, damaged), 0);
  }
});

test('structured consensus preserves exact input when disabled', () => {
  const width = 32, height = 32;
  const alpha = diamondAlpha(width, height);
  const source = image(width, height, (x, y) => [80 + x, 90 + y, 110 + ((x + y) % 7)]);
  const result = applyStructuredConsensusRepair(source, alpha, { enabled: false });
  assert.equal(result.structuredConsensus.attempted, false);
  assert.equal(meanDelta(result, source), 0);
});

test('conflicting high-detail background cannot be accepted unless measured residual improves safely', () => {
  const width = 48, height = 48;
  const alpha = diamondAlpha(width, height);
  const source = image(width, height, (x, y) => {
    const checker = ((Math.floor(x / 2) + Math.floor(y / 2)) % 2) ? 205 : 45;
    return [checker, (x * 19 + y * 7) % 230, (x * 5 + y * 23) % 230];
  });
  const result = applyStructuredConsensusRepair(source, alpha, { strength: 1 });
  const info = result.structuredConsensus;
  if (info.accepted) {
    assert.ok(info.after.total < info.before.total);
    assert.ok(info.after.luma <= info.before.luma * 1.008 + 1e-9);
    assert.ok(info.after.chroma <= info.before.chroma * 1.008 + 1e-9);
  } else {
    assert.equal(meanDelta(result, source), 0);
  }
});

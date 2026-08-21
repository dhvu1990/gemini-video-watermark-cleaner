import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPaddedTextureRepair } from '../src/video/textureRepair.js';
import { applyDarkUnderflowGuard } from '../src/video/darkUnderflowGuard.js';

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

function lumaAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}

test('padded texture repair is strongly attenuated when a real high-contrast boundary crosses the watermark', () => {
  const width = 72, height = 72;
  const alpha = diamondAlpha(width, height, 0.50);
  const boundary = (x, y) => y > 0.62 * x + 12;
  const source = image(width, height, (x, y) => boundary(x, y) ? [214, 195, 166] : [76, 48, 112]);
  const damaged = { width, height, data: new Uint8ClampedArray(source.data) };
  for (let p = 0; p < alpha.length; p++) {
    if ((alpha[p] || 0) < 0.04) continue;
    const i = p * 4;
    damaged.data[i] = Math.round(damaged.data[i] * 0.78 + 172 * 0.22);
    damaged.data[i + 1] = Math.round(damaged.data[i + 1] * 0.78 + 142 * 0.22);
    damaged.data[i + 2] = Math.round(damaged.data[i + 2] * 0.78 + 98 * 0.22);
  }
  const result = applyPaddedTextureRepair(damaged, alpha, 0.90);
  assert.ok(result.paddedTextureRepair, 'crossing-edge telemetry should be exposed');
  assert.ok(result.paddedTextureRepair.globalSceneFactor <= 0.52, JSON.stringify(result.paddedTextureRepair));
  const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
  const bright = lumaAt(result, cx - 7, cy + 8);
  const dark = lumaAt(result, cx + 7, cy - 8);
  assert.ok(bright - dark > 55, JSON.stringify({ bright, dark, telemetry: result.paddedTextureRepair }));
});

test('dark underflow guard recovers a brown near-black collapse without requiring literal black pixels', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height, 0.50);
  const original = image(width, height, () => [58, 52, 47]);
  const restored = image(width, height, (x, y) => {
    const a = alpha[y * width + x] || 0;
    return a >= 0.22 ? [20, 15, 12] : [58, 52, 47];
  });
  const beforeCenter = lumaAt(restored, 32, 32);
  const result = applyDarkUnderflowGuard(restored, original, alpha);
  assert.equal(result.darkUnderflowGuard.attempted, true, JSON.stringify(result.darkUnderflowGuard));
  assert.equal(result.darkUnderflowGuard.accepted, true, JSON.stringify(result.darkUnderflowGuard));
  assert.ok(lumaAt(result, 32, 32) > beforeCenter + 5, JSON.stringify(result.darkUnderflowGuard));
});

test('dark underflow guard still leaves genuine near-black material unchanged', () => {
  const width = 64, height = 64;
  const alpha = diamondAlpha(width, height, 0.44);
  const original = image(width, height, () => [5, 6, 7]);
  const restored = image(width, height, () => [4, 5, 6]);
  const result = applyDarkUnderflowGuard(restored, original, alpha);
  assert.equal(result.darkUnderflowGuard.attempted, false, JSON.stringify(result.darkUnderflowGuard));
  assert.deepEqual(Array.from(result.data), Array.from(restored.data));
});

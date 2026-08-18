import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPaddedRegion } from '../src/video/engine.js';

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

function shiftedFrom(source, dx, dy) {
  return image(source.width, source.height, (x, y) => {
    const sx = Math.max(0, Math.min(source.width - 1, x + dx));
    const sy = Math.max(0, Math.min(source.height - 1, y + dy));
    const i = (sy * source.width + sx) * 4;
    return [source.data[i], source.data[i + 1], source.data[i + 2]];
  });
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

test('runtime reports no temporal donor attempt when history is empty', () => {
  const width = 36, height = 36, size = 13;
  const padded = image(width, height, (x, y) => [70 + x * 2, 90 + y, 120 + ((x + y) % 7)]);
  const result = repairPaddedRegion(
    padded,
    { offsetX: 11, offsetY: 11, width: size, height: size },
    innerAlpha(size),
    1,
    0.35,
    [],
    false
  );
  assert.equal(result.temporalDonorAcceptance.attempted, false);
  assert.equal(result.temporalDonorAcceptance.reason, 'atlas-or-no-history');
});

test('runtime fallback exposes temporal donor acceptance diagnostics when atlas support is insufficient', () => {
  const width = 40, height = 40, size = 13;
  const previous = image(width, height, (x, y) => [
    35 + ((x * 11 + y * 3) % 170),
    45 + ((x * 5 + y * 13) % 165),
    55 + ((x * 7 + y * 9) % 160)
  ]);
  const current = shiftedFrom(previous, 3, -2);
  const result = repairPaddedRegion(
    current,
    { offsetX: 13, offsetY: 13, width: size, height: size },
    innerAlpha(size),
    1,
    0.35,
    [previous],
    false
  );

  assert.ok(result.temporalDonorAcceptance);
  assert.notEqual(result.temporalDonorAcceptance.reason, 'atlas-selected');
  assert.equal(typeof result.temporalDonorAcceptance.attempted, 'boolean');
  assert.equal(typeof result.temporalDonorAcceptance.accepted, 'boolean');
  if (result.temporalDonorAcceptance.attempted) {
    assert.ok(result.temporalDonorAcceptance.before);
    assert.ok(result.temporalDonorAcceptance.candidateAfter);
    assert.ok(result.temporalDonorAcceptance.temporalShift);
  }
});

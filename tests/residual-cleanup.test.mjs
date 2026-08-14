import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResidualFootprintCleanup } from '../src/video/restore.js';

test('residual cleanup changes the synthetic low-alpha edge band but leaves remote background alone', () => {
  const size = 48;
  const alpha = new Float32Array(size * size);
  const data = new Uint8ClampedArray(size * size * 4);

  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    data[i] = 100;
    data[i + 1] = 105;
    data[i + 2] = 110;
    data[i + 3] = 255;
  }

  for (let y = 12; y <= 35; y++) {
    for (let x = 12; x <= 35; x++) {
      const border = x === 12 || x === 35 || y === 12 || y === 35;
      if (!border) continue;
      const p = y * size + x;
      alpha[p] = 0.08;
      const i = p * 4;
      data[i] = 122;
      data[i + 1] = 127;
      data[i + 2] = 132;
    }
  }

  const input = { width: size, height: size, data };
  const cleaned = applyResidualFootprintCleanup(input, alpha, 0.8);

  assert.equal(cleaned.width, size);
  assert.equal(cleaned.height, size);
  assert.deepEqual(Array.from(cleaned.data.slice(0, 4)), [100, 105, 110, 255]);

  let changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (cleaned.data[i] !== data[i] || cleaned.data[i + 1] !== data[i + 1] || cleaned.data[i + 2] !== data[i + 2]) changed++;
  }
  assert.ok(changed > 0);
});

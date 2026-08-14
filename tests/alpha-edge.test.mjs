import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceAlphaEdges } from '../src/video/alpha.js';

test('edge enhancement strengthens a low-alpha border beside the watermark body', () => {
  const size = 7;
  const alpha = new Float32Array(size * size);
  const center = 3 * size + 3;
  alpha[center] = 0.42;
  alpha[center - 1] = 0.08;
  alpha[center + 1] = 0.07;
  alpha[center - size] = 0.06;
  alpha[center + size] = 0.09;

  const enhanced = enhanceAlphaEdges(alpha, size, 0.045);

  assert.equal(enhanced.length, alpha.length);
  assert.ok(enhanced[center - 1] > alpha[center - 1]);
  assert.ok(enhanced[center + 1] > alpha[center + 1]);
  assert.ok(enhanced[center] >= alpha[center]);
});

test('edge enhancement preserves empty background and bounded alpha values', () => {
  const size = 7;
  const alpha = new Float32Array(size * size);
  alpha[3 * size + 3] = 0.5;
  const enhanced = enhanceAlphaEdges(alpha, size, 0.12);

  assert.equal(enhanced[0], 0);
  for (const value of enhanced) {
    assert.ok(value >= 0);
    assert.ok(value <= 0.95);
  }
});

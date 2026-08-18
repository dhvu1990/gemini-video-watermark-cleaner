import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTemporalDonorAcceptance } from '../src/video/temporalDonorAcceptance.js';

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
      if (d <= 5) alpha[y * width + x] = 0.58;
      else if (d <= 7) alpha[y * width + x] = 0.22;
      else if (d <= 9) alpha[y * width + x] = 0.055;
    }
  }
  return alpha;
}

function withTemporalMarker(value) {
  return { ...value, temporalShift: { dx: 2, dy: -1, improvement: 0.4 }, temporalDonor: { correctedPixels: 20 } };
}

test('temporal donor acceptance rolls back a materially worse residual candidate', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const baseline = image(width, height, (x, y) => [80 + x, 96 + Math.floor(y * 0.5), 130 + ((x + y) % 4)]);
  const candidate = withTemporalMarker(image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p] || 0;
    const base = [80 + x, 96 + Math.floor(y * 0.5), 130 + ((x + y) % 4)];
    const damage = a > 0.005 && a < 0.3 ? 28 : 0;
    return [base[0] - damage, base[1] - damage, base[2] - damage];
  }));
  const result = evaluateTemporalDonorAcceptance(baseline, candidate, alpha);
  assert.equal(result.diagnostics.attempted, true);
  assert.equal(result.diagnostics.accepted, false);
  assert.equal(result.image, baseline);
  assert.equal(result.diagnostics.reason, 'residual-safety-gate');
});

test('temporal donor acceptance can keep a candidate that stays inside residual safety bounds', () => {
  const width = 51, height = 51;
  const alpha = diamondAlpha(width, height);
  const baseline = image(width, height, (x, y) => {
    const p = y * width + x;
    const a = alpha[p] || 0;
    const base = [80 + x, 96 + Math.floor(y * 0.5), 130 + ((x + y) % 4)];
    const damage = a > 0.005 && a < 0.3 ? 18 : 0;
    return [base[0] - damage, base[1] - damage, base[2] - damage];
  });
  const candidate = withTemporalMarker(image(width, height, (x, y) => [80 + x, 96 + Math.floor(y * 0.5), 130 + ((x + y) % 4)]));
  const result = evaluateTemporalDonorAcceptance(baseline, candidate, alpha);
  assert.equal(result.diagnostics.attempted, true);
  assert.equal(result.diagnostics.accepted, true);
  assert.equal(result.image, candidate);
  assert.ok(result.diagnostics.candidateAfter.total <= result.diagnostics.before.total * 1.002 + 1e-9);
});

test('no temporal candidate returns the baseline unchanged', () => {
  const width = 21, height = 21;
  const alpha = diamondAlpha(width, height);
  const baseline = image(width, height, () => [100, 110, 120]);
  const candidate = image(width, height, () => [100, 110, 120]);
  const result = evaluateTemporalDonorAcceptance(baseline, candidate, alpha);
  assert.equal(result.diagnostics.attempted, false);
  assert.equal(result.image, baseline);
});

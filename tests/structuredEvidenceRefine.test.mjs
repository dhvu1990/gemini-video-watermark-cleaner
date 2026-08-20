import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCoherentStructuredShapePass, buildStructuredEvidenceCandidate } from '../src/video/structuredEvidenceRefine.js';

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
      if (d <= 6) alpha[y * width + x] = 0.58;
      else if (d <= 9) alpha[y * width + x] = 0.22;
      else if (d <= 12) alpha[y * width + x] = 0.055;
    }
  }
  return alpha;
}

function residualScene(width, height, alpha, ghostStrength = -18) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  return image(width, height, (x, y) => {
    const base = 105 + Math.round(x * 0.45) + Math.round(y * 0.18);
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const a = alpha[y * width + x] || 0;
    const ghost = a > 0.005 && a < 0.34 && d >= 6 && d <= 12 ? ghostStrength : 0;
    return [base + ghost, base + 9 + ghost, base + 18 + ghost];
  });
}

function changedPixels(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) changed++;
  }
  return changed;
}

test('shape-coherent micro pass finds a continuous diamond-correlated residual without broad repainting', () => {
  const width = 61, height = 61;
  const alpha = diamondAlpha(width, height);
  const input = residualScene(width, height, alpha);
  const result = applyCoherentStructuredShapePass(input, alpha, {
    strength: 0.30,
    minAlignment: 0.48,
    minResidual: 0.7,
    fullResidual: 5.5,
    tangentDistance: 1.5
  });
  assert.ok(result.coherentCandidates > 0);
  assert.ok(result.correctedPixels > 0);
  assert.equal(changedPixels(input, result.image), result.correctedPixels);
  assert.ok(result.correctedPixels < width * height * 0.16);
  assert.ok(result.meanAbsLumaDelta > 0 && result.meanAbsLumaDelta < 4);
});

test('structured evidence candidate exposes a bounded persistence pass for residuals that survive the first pass', () => {
  const width = 61, height = 61;
  const alpha = diamondAlpha(width, height);
  const input = residualScene(width, height, alpha, -12);
  const candidate = buildStructuredEvidenceCandidate(input, alpha, {
    refinementStrength: 0.28,
    refinementMinAlignment: 0.48,
    refinementMinResidual: 0.7,
    refinementFullResidual: 5.0,
    refinementPersistenceStrength: 0.18,
    refinementPersistenceMinResidual: 0.5,
    refinementPersistenceMinNeighborResidual: 0.45
  });
  assert.equal(candidate.persistence.enabled, true);
  assert.equal(typeof candidate.persistence.accepted, 'boolean');
  assert.ok(candidate.persistence.correctedPixels <= width * height * 0.16);
  assert.ok(candidate.candidatePixels >= candidate.shape.correctedPixels);
  assert.ok(['shape-coherent', 'shape-coherent+persistence', 'shape-coherent+tone-micro', 'shape-coherent+persistence+tone-micro', 'tone-micro', 'none'].includes(candidate.mode));
});

test('structured evidence candidate keeps the tone micro pass conservative and observable', () => {
  const width = 61, height = 61;
  const alpha = diamondAlpha(width, height);
  const input = residualScene(width, height, alpha);
  const candidate = buildStructuredEvidenceCandidate(input, alpha, {
    refinementStrength: 0.30,
    refinementMinAlignment: 0.48,
    refinementMinResidual: 0.7,
    refinementFullResidual: 5.5
  });
  assert.ok(['shape-coherent', 'shape-coherent+persistence', 'shape-coherent+tone-micro', 'shape-coherent+persistence+tone-micro', 'tone-micro', 'none'].includes(candidate.mode));
  assert.ok(candidate.shape.coherentCandidates >= candidate.shape.correctedPixels);
  assert.equal(typeof candidate.toneMicro.accepted, 'boolean');
  assert.ok(candidate.candidatePixels >= candidate.shape.correctedPixels);
});

test('invalid alpha geometry is an exact no-op', () => {
  const input = image(21, 21, (x, y) => [80 + x, 90 + y, 100]);
  const result = applyCoherentStructuredShapePass(input, new Float32Array(3), {});
  assert.equal(result.correctedPixels, 0);
  assert.deepEqual(Array.from(result.image.data), Array.from(input.data));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSmoothBackground, applySmoothBackgroundReconstruction } from '../src/video/smoothBackground.js';
import { applyLocalToneMatch, measureLocalToneMismatch } from '../src/video/localToneMatch.js';
import { applyCoherentStructuredShapePass } from '../src/video/structuredEvidenceRefine.js';

function makeImage(width, height, fn) {
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

function diamondAlpha(width, height, scale = 1) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      let value = 0;
      if (d <= 14 * scale) value = 0.52;
      else if (d <= 17 * scale) value = 0.23;
      else if (d <= 20 * scale) value = 0.07;
      else if (d <= 22 * scale) value = 0.018;
      alpha[y * width + x] = value;
    }
  }
  return alpha;
}

function smallDiamondAlpha(width, height) {
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

function overlayWhite(clean, alpha) {
  const out = new Uint8ClampedArray(clean.data);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] || 0;
    if (a <= 0) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(clean.data[i + c] * (1 - a) + 255 * a);
  }
  return { width: clean.width, height: clean.height, data: out };
}

function averageChange(before, after, alpha, predicate) {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < alpha.length; p++) {
    if (!predicate(alpha[p] || 0)) continue;
    const i = p * 4;
    sum += Math.abs(after.data[i] - before.data[i]);
    count++;
  }
  return count ? sum / count : 0;
}

test('scene5 guard rejects smooth rebuild when independent low-contrast footprint detail would be erased', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const clean = makeImage(width, height, (x, y) => {
    let value = 42 + x * 0.08 + y * 0.04;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d < 17) {
      if (Math.abs(x - cx) <= 1) value += 8;
      if ((x + y) % 9 === 0) value += 4;
    }
    return [value, value + 3, value + 7];
  });
  const watermarked = overlayWhite(clean, alpha);
  const analysis = analyzeSmoothBackground(watermarked, alpha);
  assert.equal(analysis.safe, true, JSON.stringify(analysis));

  const result = applySmoothBackgroundReconstruction(watermarked, alpha, analysis);
  assert.equal(result.smoothBackground.detailPreservation.guardTriggered, true);
  assert.equal(result.smoothBackground.applied, false);
  assert.equal(result.smoothBackground.reason, 'detail-preservation-reject');
  assert.deepEqual(Array.from(result.data), Array.from(watermarked.data));
});

test('scene3/scene7 local tone correction is weighted toward the stronger footprint instead of painting the feather broadly', () => {
  const width = 64, height = 64;
  const alpha = smallDiamondAlpha(width, height);
  const base = makeImage(width, height, (x, y) => [92 + x * 0.55, 122 + y * 0.32, 148 + x * 0.20]);
  const damaged = { width, height, data: new Uint8ClampedArray(base.data) };
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] || 0;
    if (a < 0.05) continue;
    const i = p * 4;
    const shift = a >= 0.20 ? 8 : 4;
    damaged.data[i] += shift; damaged.data[i + 1] += shift; damaged.data[i + 2] += shift;
  }
  const before = measureLocalToneMismatch(damaged, alpha);
  const result = applyLocalToneMatch(damaged, alpha, { strength: 0.80 });
  const after = measureLocalToneMismatch(result, alpha);
  assert.equal(result.localToneMatch.accepted, true, JSON.stringify(result.localToneMatch));
  assert.ok(after.score < before.score * 0.55, `${before.score} -> ${after.score}`);
  const coreChange = averageChange(damaged, result, alpha, (a) => a >= 0.20);
  const featherChange = averageChange(damaged, result, alpha, (a) => a >= 0.05 && a < 0.20);
  assert.ok(coreChange > 1.5, `core change ${coreChange}`);
  assert.ok(featherChange < coreChange * 0.65, `core ${coreChange}, feather ${featherChange}`);
});

test('scene1/scene6 coherent structured refinement detects a weaker shape-correlated residual without broad repainting', () => {
  const width = 61, height = 61;
  const alpha = smallDiamondAlpha(width, height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const input = makeImage(width, height, (x, y) => {
    const base = 105 + Math.round(x * 0.45) + Math.round(y * 0.18);
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const a = alpha[y * width + x] || 0;
    const ghost = a > 0.005 && a < 0.34 && d >= 6 && d <= 12 ? -11 : 0;
    return [base + ghost, base + 9 + ghost, base + 18 + ghost];
  });
  const result = applyCoherentStructuredShapePass(input, alpha);
  assert.ok(result.coherentCandidates > 0, JSON.stringify(result));
  assert.ok(result.correctedPixels > 0, JSON.stringify(result));
  assert.ok(result.correctedPixels < width * height * 0.16, `changed ${result.correctedPixels}`);
  assert.ok(result.meanAbsLumaDelta > 0 && result.meanAbsLumaDelta < 3.0, `mean delta ${result.meanAbsLumaDelta}`);
});

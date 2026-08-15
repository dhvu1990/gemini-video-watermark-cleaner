import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSmoothBackground,
  applySmoothBackgroundReconstruction
} from '../src/video/smoothBackground.js';

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

function diamondAlpha(width, height) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const d = dx + dy;
      let a = 0;
      if (d <= 14) a = 0.52;
      else if (d <= 17) a = 0.23;
      else if (d <= 20) a = 0.07;
      else if (d <= 22) a = 0.018;
      alpha[y * width + x] = a;
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

function mae(a, b, mask) {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

test('smooth gradient background is classified safe and full-footprint rebuild removes the watermark', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const clean = makeImage(width, height, (x, y) => [
    35 + x * 0.55 + y * 0.08,
    102 + x * 0.30 + y * 0.20,
    170 + x * 0.22 - y * 0.06
  ]);
  const watermarked = overlayWhite(clean, alpha);
  const analysis = analyzeSmoothBackground(watermarked, alpha);
  assert.equal(analysis.safe, true, JSON.stringify(analysis));
  assert.equal(analysis.mode, 'smooth-rebuild');

  const repaired = applySmoothBackgroundReconstruction(watermarked, alpha, analysis);
  const mask = alpha.map((value) => value > 0.005);
  const before = mae(watermarked, clean, mask);
  const after = mae(repaired, clean, mask);
  assert.equal(repaired.smoothBackground.applied, true);
  assert.ok(after < before * 0.18, `expected strong reconstruction improvement: ${before} -> ${after}`);
});

test('structured keyboard-like background is rejected from aggressive rebuild', () => {
  const width = 81, height = 81;
  const alpha = diamondAlpha(width, height);
  const structured = makeImage(width, height, (x, y) => {
    const keyRow = Math.floor(y / 8) % 2;
    const keyCol = Math.floor(x / 11) % 2;
    const diagonal = Math.abs(((x + y * 2) % 27) - 13) < 2 ? 52 : 0;
    const grid = (x % 11 < 2 || y % 8 < 2) ? 34 : 0;
    const base = 42 + keyRow * 14 + keyCol * 10;
    return [base + grid + diagonal, 70 + grid + diagonal, 112 + grid + diagonal];
  });
  const analysis = analyzeSmoothBackground(structured, alpha);
  assert.equal(analysis.safe, false, JSON.stringify(analysis));
  assert.equal(analysis.mode, 'structured');
  assert.ok(
    analysis.edgeDensity > analysis.thresholds.maxEdgeDensity
      || analysis.meanLaplacian > analysis.thresholds.maxMeanLaplacian
      || analysis.coreStructureDensity > analysis.thresholds.maxCoreStructureDensity
      || analysis.complexity > analysis.thresholds.maxComplexity,
    'structured sample should fail at least one safety gate'
  );
});

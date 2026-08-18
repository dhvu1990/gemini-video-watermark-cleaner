import test from 'node:test';
import assert from 'node:assert/strict';
import { measureCalibrationArtifactResidual } from '../src/video/calibrationArtifactMetrics.js';

function makeAlpha(width = 72, height = 72) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      alpha[y * width + x] = Math.max(0, 0.64 - d * 0.052);
    }
  }
  return alpha;
}

function makeGradient(width = 72, height = 72) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = 96 + x * 0.31 + y * 0.17;
      const i = (y * width + x) * 4;
      data[i] = Math.round(base + 18);
      data[i + 1] = Math.round(base + 6);
      data[i + 2] = Math.round(base - 9);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function cloneImage(image) {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

function addShift(image, p, shift) {
  const i = p * 4;
  for (let c = 0; c < 3; c++) image.data[i + c] = Math.max(0, Math.min(255, image.data[i + c] + shift));
}

function injectCalibrationArtifacts(image, alpha) {
  const out = cloneImage(image);
  const { width, height } = out;
  const cx = (width - 1) / 2;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const a = alpha[p] || 0;
      if (a >= 0.07 && a <= 0.68) addShift(out, p, 5);
      if (Math.abs(x - cx) <= 1.25 && a >= 0.055 && a <= 0.70) addShift(out, p, 5);
    }
  }

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      if ((alpha[p] || 0) > 0.012) continue;
      let nearFootprint = false;
      for (let dy = -2; dy <= 2 && !nearFootprint; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          if (Math.hypot(dx, dy) > 2.01) continue;
          if ((alpha[(y + dy) * width + x + dx] || 0) >= 0.025) {
            nearFootprint = true;
            break;
          }
        }
      }
      if (nearFootprint) addShift(out, p, -6);
    }
  }
  return out;
}

test('calibration artifact metric rises for seam, tone and thin outer-halo residuals', () => {
  const width = 72, height = 72;
  const alpha = makeAlpha(width, height);
  const clean = makeGradient(width, height);
  const damaged = injectCalibrationArtifacts(clean, alpha);
  const options = {
    centerSeamOptions: { maxAnchorDisagreement: 34 },
    localToneOptions: { referenceGradientMax: 12, gradientMax: 15 },
    outerHaloOptions: { referenceDisagreementMax: 18, tangentSpanMax: 20 }
  };

  const cleanScore = measureCalibrationArtifactResidual(clean, alpha, options);
  const damagedScore = measureCalibrationArtifactResidual(damaged, alpha, options);

  assert.ok(Number.isFinite(cleanScore.score));
  assert.ok(damagedScore.coverage > 0.35);
  assert.ok(damagedScore.score > cleanScore.score + 0.75);
  assert.ok(damagedScore.tone.score > cleanScore.tone.score + 1.5);
  assert.ok(damagedScore.halo.score > cleanScore.halo.score + 1.0);
  assert.ok(damagedScore.seam.score > cleanScore.seam.score + 1.0);
});

test('calibration artifact metric exposes confidence-weighted component diagnostics', () => {
  const alpha = makeAlpha();
  const image = makeGradient();
  const result = measureCalibrationArtifactResidual(image, alpha);

  assert.ok(result.components);
  assert.ok(result.coverage >= 0 && result.coverage <= 1);
  assert.ok(result.effectiveWeight >= 0);
  for (const name of ['seam', 'tone', 'halo']) {
    assert.ok(result.components[name].confidence >= 0 && result.components[name].confidence <= 1);
    assert.ok(result.components[name].effectiveWeight >= 0);
  }
});

test('calibration artifact metric safely returns zero coverage for invalid alpha geometry', () => {
  const image = makeGradient();
  const result = measureCalibrationArtifactResidual(image, new Float32Array(3));
  assert.equal(result.score, 0);
  assert.equal(result.coverage, 0);
  assert.equal(result.effectiveWeight, 0);
  assert.equal(result.components, null);
});

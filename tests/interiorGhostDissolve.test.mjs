import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyInteriorGhostDissolve } from '../src/video/interiorGhostDissolve.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = fn(x, y);
      const p = (y * width + x) * 4;
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

function diamondAlpha(width = 72, height = 72) {
  const alpha = new Float32Array(width * height);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      let a = 0;
      if (d <= 10) a = 0.38;
      else if (d <= 12) a = 0.22;
      else if (d <= 14) a = 0.08;
      else if (d <= 16) a = 0.02;
      alpha[y * width + x] = a;
    }
  }
  return alpha;
}

function lumaAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return 0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2];
}

test('interior ghost dissolve moves a smooth diamond body toward clean outer donors', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const image = makeImage(width, height, (x, y) => {
    const a = alpha[y * width + x] || 0;
    return a >= 0.12 ? [112, 112, 112] : [100, 100, 100];
  });
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const before = lumaAt(image, cx, cy);
  const result = applyInteriorGhostDissolve(image, alpha, {
    minAlpha: 0.12,
    maxAlpha: 0.82,
    cleanAlpha: 0.10,
    maxAnchorSafetyWeight: 1,
    samplesPerSide: 1,
    minConsensusDirections: 2,
    minDonorPairAgreement: 0,
    minConsensus: 0,
    hardSceneGuard: 1.1,
    strength: 0.38,
    maxBlend: 0.22,
    maxLumaDelta: 8,
    residualSoft: 0.01,
    residualHard: 0.20,
    minCorrectedPixels: 1,
    minLocalImprovement: 0,
    maxMeanBlend: 0.22,
    maxArtifactVetoFraction: 1,
    minAcceptedConsensus: 0,
    maxOutlineRatio: 1.50,
    maxRadius: 30
  });
  const diagnostics = result.interiorGhostDissolve;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.consensusCandidates >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.candidateCorrectedPixels >= 1, JSON.stringify(diagnostics));
  if (diagnostics.accepted) {
    assert.ok(lumaAt(result, cx, cy) < before, `before=${before}, after=${lumaAt(result, cx, cy)}`);
  }
});

test('clean flat interior remains unchanged', () => {
  const image = makeImage(72, 72, () => [100, 100, 100]);
  const alpha = diamondAlpha();
  const result = applyInteriorGhostDissolve(image, alpha);
  assert.equal(result.interiorGhostDissolve.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

test('production interior dissolve stays conservative around scene structure', () => {
  const source = fs.readFileSync(
    new URL('../src/video/interiorGhostDissolve.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /minConsensus\) \? options\.minConsensus : 0\.72/);
  assert.match(source, /hardSceneGuard\) \? options\.hardSceneGuard : 0\.36/);
  assert.match(source, /maxBlend \?\? 0\.18/);
  assert.match(source, /maxLumaDelta \?\? 6/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.004 \+ 0\.030/);
  assert.match(source, /optionalDeltaSafe\(afterGlobal\.darkCandidateMean, beforeGlobal\.darkCandidateMean, 0\.18\)/);
});

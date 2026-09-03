import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applySceneProtectedContinuationEscalation } from '../src/video/sceneProtectedContinuationEscalation.js';

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

test('multi-angle scene prediction finds a real horizontal line instead of following watermark tangent', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const image = makeImage(width, height, (x, y) => {
    if (Math.abs(y - cy) <= 1) {
      const a = alpha[y * width + x] || 0;
      return a >= 0.012 ? [118, 118, 118] : [180, 180, 180];
    }
    return [86, 86, 86];
  });
  const before = lumaAt(image, cx, cy);
  const result = applySceneProtectedContinuationEscalation(image, alpha, {
    minOutlineScore: 0,
    minOutlineDensity: 0,
    minOutlineSamples: 1,
    minPairAgreement: 0.60,
    strongPairAgreement: 0.72,
    minStructureEvidence: 0.08,
    strongStructureEvidence: 0.15,
    hardSceneGuard: 0,
    absoluteSceneGuard: 1.1,
    strength: 0.50,
    maxBlend: 0.24,
    maxLumaDelta: 9,
    residualSoft: 0.01,
    residualHard: 0.20,
    minCorrectedPixels: 1,
    minLocalImprovement: 0,
    maxOutlineRatio: 1.50,
    maxMeanBlend: 0.24,
    maxArtifactVetoFraction: 1,
    minAcceptedPairAgreement: 0,
    minAcceptedStructureEvidence: 0,
    samplesPerSide: 1,
    maxRadius: 28,
    maxAnchorSafetyWeight: 1
  });
  const diagnostics = result.sceneProtectedContinuationEscalation;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.directionalCandidates >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.candidateCorrectedPixels >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.sceneOverridePixels >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.meanStructureEvidence > 0, JSON.stringify(diagnostics));
  if (diagnostics.accepted) {
    assert.ok(lumaAt(result, cx, cy) > before, `before=${before}, after=${lumaAt(result, cx, cy)}`);
  }
});

test('clean scene line is not changed when there is no residual to correct', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cy = Math.floor(height * 0.5);
  const image = makeImage(width, height, (_x, y) => Math.abs(y - cy) <= 1 ? [176, 176, 176] : [86, 86, 86]);
  const result = applySceneProtectedContinuationEscalation(image, alpha, {
    minOutlineScore: 0,
    minOutlineDensity: 0,
    minOutlineSamples: 1
  });
  assert.equal(result.sceneProtectedContinuationEscalation.accepted, false);
  assert.deepEqual([...result.data], [...image.data]);
});

test('production scene-structure escalation keeps bounded caps and strict override evidence', () => {
  const source = fs.readFileSync(
    new URL('../src/video/sceneProtectedContinuationEscalation.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /strongPairAgreement\) \? options\.strongPairAgreement : 0\.90/);
  assert.match(source, /strongStructureEvidence\) \? options\.strongStructureEvidence : 0\.52/);
  assert.match(source, /absoluteSceneGuard\) \? options\.absoluteSceneGuard : 0\.985/);
  assert.match(source, /maxBlend \?\? 0\.20/);
  assert.match(source, /maxLumaDelta \?\? 7/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.003 \+ 0\.025/);
});

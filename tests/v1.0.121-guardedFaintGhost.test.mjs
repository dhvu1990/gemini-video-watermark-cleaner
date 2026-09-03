import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyGuardedFaintGhostDissolve } from '../src/video/guardedFaintGhostDissolve.js';

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

const acceptanceRelaxation = {
  minCorrectedPixels: 1,
  minLocalImprovement: 0,
  minAcceptedConsensus: 0,
  maxOutlineRatio: 1.50,
  maxMeanBlend: 0.18,
  maxArtifactVetoFraction: 1,
  maxGuardedMeanBlend: 0.09,
  maxGuardedAppliedLumaDelta: 4
};

test('v1.0.121 dissolves faint low-alpha ghost missed by the older interior floor', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const sampleX = cx + 13;
  const image = makeImage(width, height, (x, y) => {
    const a = alpha[y * width + x] || 0;
    return a >= 0.055 ? [108, 108, 108] : [100, 100, 100];
  });
  const before = lumaAt(image, sampleX, cy);
  const result = applyGuardedFaintGhostDissolve(image, alpha, {
    ...acceptanceRelaxation,
    minConsensus: 0,
    minDonorPairAgreement: 0,
    hardSceneGuard: 1.1,
    residualSoft: 0.01,
    residualHard: 0.20,
    samplesPerSide: 1,
    maxAnchorSafetyWeight: 1
  });
  const diagnostics = result.guardedFaintGhostDissolve;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.candidateFaintCorrectedPixels >= 1, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, true, JSON.stringify(diagnostics));
  assert.ok(lumaAt(result, sampleX, cy) < before, `before=${before}, after=${lumaAt(result, sampleX, cy)}`);
});

test('guarded micro-override cleans faint residue beside high-contrast text while preserving the text stroke', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const cx = Math.floor(width * 0.5);
  const cy = Math.floor(height * 0.5);
  const ghostY = cy + 1;
  const image = makeImage(width, height, (x, y) => {
    if (y === cy) return [220, 220, 220];
    const a = alpha[y * width + x] || 0;
    if (y === ghostY && a >= 0.055) return [72, 72, 72];
    return [80, 80, 80];
  });
  const lineBefore = lumaAt(image, cx, cy);
  const ghostBefore = lumaAt(image, cx, ghostY);
  const result = applyGuardedFaintGhostDissolve(image, alpha, {
    ...acceptanceRelaxation,
    hardSceneGuard: 0.05,
    absoluteSceneGuard: 1.01,
    residualSoft: 0.01,
    residualHard: 0.20,
    samplesPerSide: 1,
    maxAnchorSafetyWeight: 1
  });
  const diagnostics = result.guardedFaintGhostDissolve;
  assert.equal(diagnostics.attempted, true, JSON.stringify(diagnostics));
  assert.ok(diagnostics.guardedOverrideCandidates >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.strongStructureVetoPixels >= 1, JSON.stringify(diagnostics));
  assert.ok(diagnostics.candidateGuardedOverridePixels >= 1, JSON.stringify(diagnostics));
  assert.equal(diagnostics.accepted, true, JSON.stringify(diagnostics));
  assert.equal(lumaAt(result, cx, cy), lineBefore, 'strong real text stroke must remain unchanged');
  assert.ok(lumaAt(result, cx, ghostY) > ghostBefore, `before=${ghostBefore}, after=${lumaAt(result, cx, ghostY)}`);
});

test('production guarded faint pass keeps strict caps for real scene structure', () => {
  const source = fs.readFileSync(
    new URL('../src/video/guardedFaintGhostDissolve.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /maxResidual\) \? options\.maxResidual : 18/);
  assert.match(source, /guardedMinConsensus\) \? options\.guardedMinConsensus : 0\.88/);
  assert.match(source, /guardedMaxResidual\) \? options\.guardedMaxResidual : 12/);
  assert.match(source, /absoluteSceneGuard\) \? options\.absoluteSceneGuard : 0\.995/);
  assert.match(source, /guardedMaxBlend \?\? 0\.065/);
  assert.match(source, /guardedMaxLumaDelta \?\? 3\.25/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.0035 \+ 0\.025/);
});

test('v1.0.121 wrapper runs guarded faint dissolve after scene continuation and interior dissolve', () => {
  const source = fs.readFileSync(
    new URL('../src/video/residualStructureContinuation.js', import.meta.url),
    'utf8'
  );
  const sceneIndex = source.lastIndexOf('applySceneProtectedContinuationEscalation');
  const interiorIndex = source.lastIndexOf('applyInteriorGhostDissolve');
  const guardedIndex = source.lastIndexOf('applyGuardedFaintGhostDissolve');
  assert.ok(sceneIndex >= 0);
  assert.ok(interiorIndex > sceneIndex);
  assert.ok(guardedIndex > interiorIndex);
  assert.match(source, /guardedFaintGhostDissolveAccepted/);
  assert.match(source, /strongStructureVetoPixels/);
});

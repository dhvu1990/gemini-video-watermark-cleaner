import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateSmoothRebuildArtifactGuard } from '../src/video/smoothRebuildArtifactGuard.js';
import { naturalBatchFileCompare, sortBatchFiles } from '../src/batch.js';

function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
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
      if (d <= 14) alpha[y * width + x] = 0.42;
      else if (d <= 18) alpha[y * width + x] = 0.12;
    }
  }
  return alpha;
}

test('v1.0.130 physical artifact guard rejects a broad dark cleanup blotch even without residual-score checks', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const before = image(width, height, (x, y) => 118 + Math.round(x * 0.08 + y * 0.05));
  const candidate = { width, height, data: new Uint8ClampedArray(before.data) };
  for (let p = 0; p < alpha.length; p++) {
    if ((alpha[p] || 0) < 0.018) continue;
    const i = p * 4;
    candidate.data[i] = Math.max(0, candidate.data[i] - 18);
    candidate.data[i + 1] = Math.max(0, candidate.data[i + 1] - 18);
    candidate.data[i + 2] = Math.max(0, candidate.data[i + 2] - 18);
  }

  const guard = evaluateSmoothRebuildArtifactGuard(before, candidate, alpha, {
    residualChecksEnabled: false
  });

  assert.equal(guard.rollback, true, JSON.stringify(guard));
  assert.equal(guard.reason, 'destructive-tone-shift', JSON.stringify(guard));
  assert.equal(guard.residualChecksEnabled, false);
  assert.ok(guard.change.meanSignedLumaDelta < -15, JSON.stringify(guard.change));
  assert.ok(guard.change.severeDarkShiftFraction > 0.8, JSON.stringify(guard.change));
});

test('v1.0.130 physical artifact guard accepts a small conservative tone correction', () => {
  const width = 72;
  const height = 72;
  const alpha = diamondAlpha(width, height);
  const before = image(width, height, (x, y) => 110 + ((x + y) % 9));
  const candidate = { width, height, data: new Uint8ClampedArray(before.data) };
  for (let p = 0; p < alpha.length; p++) {
    if ((alpha[p] || 0) < 0.018) continue;
    const i = p * 4;
    candidate.data[i] = Math.max(0, candidate.data[i] - 2);
    candidate.data[i + 1] = Math.max(0, candidate.data[i + 1] - 2);
    candidate.data[i + 2] = Math.max(0, candidate.data[i + 2] - 2);
  }

  const guard = evaluateSmoothRebuildArtifactGuard(before, candidate, alpha, {
    residualChecksEnabled: false
  });
  assert.equal(guard.rollback, false, JSON.stringify(guard));
});

test('v1.0.130 late cleanup wrapper uses fixed conservative strength and makes body rescue opt-in', () => {
  const source = fs.readFileSync(
    new URL('../src/video/persistentContourSilhouetteDissolve.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /cleanupConfidence[^\n]*0\.55/);
  assert.match(source, /applyPersistentContourCore\(image, alphaMap, cleanupOptions\)/);
  assert.match(source, /highConfidenceBodyResidualRescue === true/);
  assert.match(source, /detectionConfidence: cleanupConfidence/);
  assert.match(source, /residualChecksEnabled: false/);
  assert.match(source, /qualityRollback/);
});

test('v1.0.130 natural batch ordering keeps numbered scenes in human order', () => {
  const files = [
    { name: 'scene10.mp4', size: 1 },
    { name: 'scene2.mp4', size: 1 },
    { name: 'scene1.mp4', size: 1 },
    { name: 'Scene7.mp4', size: 1 }
  ];
  const sorted = sortBatchFiles(files).map((file) => file.name);
  assert.deepEqual(sorted, ['scene1.mp4', 'scene2.mp4', 'Scene7.mp4', 'scene10.mp4']);
  assert.ok(naturalBatchFileCompare({ name: 'scene9.mp4' }, { name: 'scene11.mp4' }) < 0);
});

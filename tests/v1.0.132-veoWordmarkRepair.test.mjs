import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildVeoWordmarkAlphaMap, repairVeoWordmarkPaddedRegion } from '../src/video/veoWordmark.js';

const SIZE = 67;

function makeFrame({ withMark = false, crossingEdge = false, checker = false } = {}) {
  const alpha = buildVeoWordmarkAlphaMap(SIZE);
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const truth = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const p = y * SIZE + x, i = p * 4;
    const edge = crossingEdge && x >= Math.floor(SIZE / 2) ? 90 : 0;
    const texture = checker ? ((x + y) % 2) * 85 : 0;
    const base = [65 + x * 0.20 + y * 0.19, 40 + x * 0.18 + y * 0.13, 25 + x * 0.12 + y * 0.08];
    for (let c = 0; c < 3; c++) {
      const clean = Math.round(base[c] + edge + texture);
      truth[i + c] = clean;
      data[i + c] = withMark ? Math.round(clean * (1 - alpha[p]) + 255 * alpha[p]) : clean;
    }
    data[i + 3] = truth[i + 3] = 255;
  }
  return { image: { width: SIZE, height: SIZE, data }, truth, alpha };
}

function restore(image, alpha) {
  return repairVeoWordmarkPaddedRegion(image, {
    offsetX: 0, offsetY: 0, width: image.width, height: image.height
  }, alpha, 1);
}

function meanAbsoluteColorError(data, truth) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs(data[i + c] - truth[i + c]);
  }
  return sum / ((data.length / 4) * 3);
}

test('v1.0.132 reconstructs a synthetic visible three-letter mark without an inverse-alpha outline', () => {
  const { image, truth, alpha } = makeFrame({ withMark: true });
  const restored = restore(image, alpha);
  const before = meanAbsoluteColorError(image.data, truth);
  const after = meanAbsoluteColorError(restored.cleaned.data, truth);
  assert.equal(restored.veoWordmark.accepted, true, restored.veoWordmark.reason);
  assert.ok(restored.veoWordmark.correctedPixels > 100);
  assert.ok(after < before * 0.25, 'before=' + before + ' after=' + after);
  for (let y = 0; y < 20; y++) {
    const start = y * SIZE * 4;
    assert.deepEqual(restored.cleaned.data.slice(start, start + SIZE * 4), image.data.slice(start, start + SIZE * 4));
  }
});

test('v1.0.132 never invents cleanup for a smooth region with no visible wordmark', () => {
  const { image, alpha } = makeFrame();
  const restored = restore(image, alpha);
  assert.equal(restored.veoWordmark.accepted, false);
  assert.equal(restored.veoWordmark.reason, 'insufficient-three-letter-evidence');
  assert.deepEqual(restored.cleaned.data, image.data);
});

test('v1.0.132 protects a real scene edge crossing the text footprint', () => {
  const { image, alpha } = makeFrame({ withMark: true, crossingEdge: true });
  const restored = restore(image, alpha);
  assert.equal(restored.veoWordmark.accepted, false);
  assert.equal(restored.veoWordmark.reason, 'crossing-scene-edge');
  assert.deepEqual(restored.cleaned.data, image.data);
  assert.ok(restored.antiStreakDiagnostics.riskFlags.includes('wordmark-repair-crossing-scene-edge'));
});

test('v1.0.132 rejects high-frequency conflicting exterior donors', () => {
  const { image, alpha } = makeFrame({ withMark: true, checker: true });
  const restored = restore(image, alpha);
  assert.equal(restored.veoWordmark.accepted, false);
  assert.equal(restored.veoWordmark.reason, 'high-exterior-structure-risk');
  assert.deepEqual(restored.cleaned.data, image.data);
});

test('v1.0.132 exposes the identical specialized repair in inspection and export paths', () => {
  const engine = fs.readFileSync(new URL('../src/video/engine.js', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../src/video/worker.js', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const wordmark = fs.readFileSync(new URL('../src/video/veoWordmark.js', import.meta.url), 'utf8');
  assert.match(wordmark, /export \{ repairVeoWordmarkPaddedRegion \} from '\.\/veoWordmarkRepair\.js'/);
  assert.match(engine, /const repair = isVeoWordmarkCandidate\(detection\.candidateId\) \? repairVeoWordmarkPaddedRegion : repairPaddedRegion/);
  assert.match(engine, /const repair = wordmark \? repairVeoWordmarkPaddedRegion : repairPaddedRegion/);
  assert.match(engine, /veoWordmark: repaired\.veoWordmark \|\| null/);
  assert.match(worker, /candidateId: options\?\.candidateId \|\| calibration\.candidateId/);
  assert.match(main, /Veo stroke\+shadow reconstruction/);
});

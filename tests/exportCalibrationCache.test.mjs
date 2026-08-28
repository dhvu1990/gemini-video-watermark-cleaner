import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clearActiveAlphaCalibration,
  getActiveAlphaCalibration,
  getVideoAlphaMap,
  setActiveAlphaCalibration
} from '../src/video/alpha.js';
import {
  calibrationMatchesRegion,
  createDetectionCalibrationCache,
  fileCalibrationKey,
  selectExportAlphaGain
} from '../src/video/exportCalibrationCache.js';

function alpha(size, value) {
  const map = new Float32Array(size * size);
  map.fill(value);
  return map;
}

test('per-file calibration cache separates same-sized batch videos and requires the same detected region', () => {
  const cache = createDetectionCalibrationCache(4);
  const fileA = { name: 'scene1.mp4', size: 1234, lastModified: 10, type: 'video/mp4' };
  const fileB = { name: 'scene2.mp4', size: 2345, lastModified: 11, type: 'video/mp4' };
  const position = { x: 864, y: 1704, width: 72, height: 72 };
  const a = alpha(72, 0.11);
  const b = alpha(72, 0.22);

  cache.remember(fileA, { position, alphaMap: a, alphaGain: 0.84, candidateId: 'veo-a' });
  cache.remember(fileB, { position, alphaMap: b, alphaGain: 0.67, candidateId: 'veo-b' });

  assert.notEqual(fileCalibrationKey(fileA), fileCalibrationKey(fileB));
  const cachedA = cache.get(fileA, { x: 864, y: 1704, size: 72 });
  const cachedB = cache.get(fileB, { x: 864, y: 1704, size: 72 });
  assert.equal(cachedA.alphaMap[0], a[0]);
  assert.equal(cachedB.alphaMap[0], b[0]);
  assert.equal(cachedA.alphaGain, 0.84);
  assert.equal(cachedB.alphaGain, 0.67);
  assert.notEqual(cachedA.alphaMap, a);
  assert.equal(cache.get(fileA, { x: 865, y: 1704, size: 72 }), null);
  assert.equal(calibrationMatchesRegion(cachedA, { x: 864, y: 1704, size: 72 }), true);
});

test('default batch gain reuses detector calibration while a non-default operator override wins', () => {
  assert.equal(selectExportAlphaGain(1, 0.73), 0.73);
  assert.equal(selectExportAlphaGain(0.91, 0.73), 0.91);
  assert.equal(selectExportAlphaGain(Number.NaN, 0.73), 0.73);
  assert.equal(selectExportAlphaGain(1, Number.NaN), 1);
});

test('active refined alpha can be scoped to export and then cleared without leaking to the next video', async () => {
  const size = 48;
  const refined = alpha(size, 0.137);
  clearActiveAlphaCalibration();
  try {
    setActiveAlphaCalibration(size, refined, { source: 'test' });
    const active = getActiveAlphaCalibration(size);
    assert.ok(active);
    assert.equal(active.metadata.source, 'test');
    const selected = await getVideoAlphaMap(size);
    assert.deepEqual(Array.from(selected), Array.from(refined));

    clearActiveAlphaCalibration(size);
    assert.equal(getActiveAlphaCalibration(size), null);
    const fallback = await getVideoAlphaMap(size);
    assert.notDeepEqual(Array.from(fallback), Array.from(refined));
  } finally {
    clearActiveAlphaCalibration();
  }
});

test('worker caches inspect calibration and activates it before the detected-region export path', () => {
  const worker = fs.readFileSync(new URL('../src/video/worker.js', import.meta.url), 'utf8');
  const engine = fs.readFileSync(new URL('../src/video/engine.js', import.meta.url), 'utf8');
  assert.match(worker, /cacheInspectionCalibration\(message\.file, result\)/);
  assert.match(worker, /ensureExportCalibration\(message\.file, message\.options \|\| \{\}, progress\)/);
  assert.match(worker, /setActiveAlphaCalibration\(size, calibration\.alphaMap/);
  assert.match(worker, /selectExportAlphaGain\(options\?\.alphaGain, calibration\.alphaGain, 1\)/);
  assert.match(worker, /finally \{\s*\/\/ Never let one same-sized video's refined alpha leak[\s\S]*clearActiveAlphaCalibration\(\)/);
  assert.match(engine, /const alphaMap = manual \|\| detectedRegion \? await getVideoAlphaMap\(position\.width\) : analysis\.internalDetection\.alphaMap/);
});

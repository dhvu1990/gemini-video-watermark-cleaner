import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const batchUi = fs.readFileSync(new URL('../src/batch-ui.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const engine = fs.readFileSync(new URL('../src/video/engine.js', import.meta.url), 'utf8');

test('batch preview preserves each inspected alpha map and forwards it to export', () => {
  assert.match(batchUi, /detectionAlphaMap:\s*null/);
  assert.match(batchUi, /item\.detectionAlphaMap\s*=\s*inspected\.result\?\.internalDetection\?\.alphaMap\s*\|\|\s*null/g);
  assert.match(batchUi, /processOptions\(item\.detection,\s*item\.detectionAlphaMap\)/);
  assert.match(batchUi, /detectedAlphaMap,/);
});

test('batch default gain follows per-file detector calibration without overriding an explicit tune', () => {
  assert.match(batchUi, /resolveDetectedAlphaGain\(configuredGain,\s*detection\?\.alphaGain,\s*1\)/);
});

test('single-video export forwards the inspected alpha map explicitly', () => {
  assert.match(main, /detection\?\.internalDetection\?\.alphaMap\s*\|\|\s*null/);
  assert.match(main, /detectedAlphaMap,/);
});

test('detected-region export validates cached map and uses deterministic fallback instead of active auto calibration', () => {
  assert.match(engine, /normalizeDetectedAlphaMap\(options\.detectedAlphaMap,\s*position\.width,\s*position\.height\)/);
  assert.match(engine, /alphaMapSource\s*=\s*'cached-detection'/);
  assert.match(engine, /getVideoAlphaMap\(position\.width,\s*baseAlphaProfileForSize\(position\.width\),\s*0\)/);
  assert.doesNotMatch(engine, /manual\s*\|\|\s*detectedRegion\s*\?\s*await getVideoAlphaMap\(position\.width\)/);
});

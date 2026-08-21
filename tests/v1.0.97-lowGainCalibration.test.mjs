import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bodyGainCandidates } from '../src/video/calibration.js';

test('normal calibration preserves the legacy 0.55 body-gain floor', () => {
  const values = bodyGainCandidates(1);
  assert.ok(values.every((value) => value >= 0.55));
  assert.ok(values.includes(1));
});

test('faint calibration can search genuinely low watermark opacity gains', () => {
  const values = bodyGainCandidates(0.65, { minimumGain: 0.10, includeLowGainAnchors: true });
  assert.ok(values.includes(0.10));
  assert.ok(values.includes(0.16));
  assert.ok(values.includes(0.24));
  assert.ok(values.some((value) => value < 0.45));
  assert.ok(values.every((value) => value >= 0.10 && value <= 1.35));
});

test('faint detector path uses low-gain search against an untouched ROI baseline', () => {
  const source = fs.readFileSync(new URL('../src/video/detect.js', import.meta.url), 'utf8');
  assert.match(source, /minimumBodyGain:\s*faintCalibrationMode \? 0\.10 : 0\.55/);
  assert.match(source, /lowGainSearch:\s*faintCalibrationMode/);
  assert.match(source, /compareToNoCleanup:\s*faintCalibrationMode/);
});

test('calibration exposes whether safety improvement was measured against no cleanup', () => {
  const source = fs.readFileSync(new URL('../src/video/calibration.js', import.meta.url), 'utf8');
  assert.match(source, /scoreUnmodifiedSamples/);
  assert.match(source, /baselineMode = compareToNoCleanup \? 'no-cleanup' : 'default-cleanup'/);
});

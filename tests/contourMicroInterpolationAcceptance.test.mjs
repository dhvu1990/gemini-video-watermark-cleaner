import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/video/contourMicroInterpolation.js', import.meta.url), 'utf8');

test('micro interpolation measures the corrected contour band separately', () => {
  assert.match(source, /localBeforeResidualSum/);
  assert.match(source, /localAfterResidualSum/);
  assert.match(source, /localImprovement/);
  assert.match(source, /guardedFraction/);
});

test('local-band fallback remains conservative and keeps global rollback mandatory', () => {
  assert.match(source, /candidate\.localImprovement >= localMinImprovement/);
  assert.match(source, /candidate\.guardedFraction <= localMaxGuardedFraction/);
  assert.match(source, /candidate\.meanBlend <= localMaxMeanBlend/);
  assert.match(source, /afterOutline\.score <= beforeOutline\.score/);
  assert.match(source, /&& globalSafe/);
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.004 \+ 0\.03/);
  assert.match(source, /afterGlobal\.luma <= beforeGlobal\.luma \* 1\.005 \+ 0\.03/);
  assert.match(source, /afterGlobal\.chroma <= beforeGlobal\.chroma \* 1\.004 \+ 0\.25/);
});

test('v1.0.113 does not increase interpolation strength or scene-edge tolerance', () => {
  assert.match(source, /hardSceneGuard[^\n]*0\.40/);
  assert.match(source, /strength[^\n]*0\.42/);
  assert.match(source, /maxBlend[^\n]*0\.30/);
  assert.match(source, /maxLumaDelta[^\n]*7/);
});

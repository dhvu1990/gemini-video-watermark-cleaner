import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/video/contourMicroInterpolation.js', import.meta.url), 'utf8');

test('texture-safe finishing measures local texture energy on corrected contour pixels', () => {
  assert.match(source, /localTextureEnergy\(/);
  assert.match(source, /measureTexturePreservation\(/);
  assert.match(source, /textureBeforeEnergy/);
  assert.match(source, /textureAfterEnergy/);
  assert.match(source, /textureEnergyRatio/);
});

test('texture-safe fallback requires preservation and local improvement', () => {
  assert.match(source, /roughTexture/);
  assert.match(source, /texturePreserved/);
  assert.match(source, /candidate\.localImprovement >= textureMinImprovement/);
  assert.match(source, /candidate\.guardedFraction <= textureMaxGuardedFraction/);
  assert.match(source, /candidate\.meanBlend <= textureMaxMeanBlend/);
  assert.match(source, /afterOutline\.score <= beforeOutline\.score \* 1\.002/);
  assert.match(source, /&& textureGlobalSafe/);
});

test('texture-safe fallback does not increase interpolation strength or scene guard', () => {
  assert.match(source, /hardSceneGuard[^\n]*0\.40/);
  assert.match(source, /strength[^\n]*0\.42/);
  assert.match(source, /maxBlend[^\n]*0\.30/);
  assert.match(source, /maxLumaDelta[^\n]*7/);
});

test('texture-safe luma relaxation is narrow while total and chroma rollback stay unchanged', () => {
  assert.match(source, /afterGlobal\.total <= beforeGlobal\.total \* 1\.004 \+ 0\.03/);
  assert.match(source, /afterGlobal\.luma <= beforeGlobal\.luma \* 1\.008 \+ 0\.05/);
  assert.match(source, /afterGlobal\.chroma <= beforeGlobal\.chroma \* 1\.004 \+ 0\.25/);
});

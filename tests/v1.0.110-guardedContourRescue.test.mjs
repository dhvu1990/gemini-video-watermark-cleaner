import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rescueSource = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');
const previewSource = readFileSync(new URL('../src/batchPreviewModel.js', import.meta.url), 'utf8');

test('guarded contour rescue opens more safe contour area while lowering local correction caps', () => {
  assert.match(rescueSource, /outlineEscalationMaxSceneGuardedRatio, 0\.68/);
  assert.match(rescueSource, /outlineEscalationMaxPartialSceneGuardedRatio, 0\.68/);
  assert.match(rescueSource, /outlineEscalationPartialMinSafeContourRatio, 0\.30/);
  assert.match(rescueSource, /outlineEscalationMaxPartialSceneEdgeDensity, 0\.42/);
  assert.match(rescueSource, /outlineEscalationMaxPartialSceneEdgeContinuityDensity, 0\.34/);
  assert.match(rescueSource, /outlineEscalationPartialStrength, 0\.46/);
  assert.match(rescueSource, /outlineEscalationPartialMaxBlend, 0\.36/);
  assert.match(rescueSource, /outlineEscalationPartialMaxLumaDelta, 8/);
  assert.match(rescueSource, /outlineEscalationPartialHardSceneGuard, 0\.44/);
});

test('body override opens strong residual contours but becomes more conservative per pixel', () => {
  assert.match(rescueSource, /outlineEscalationBodyOverrideMaxBodyScore, 12\.0/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideMinDominance, 0\.20/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideStrength, 0\.44/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideMaxBlend, 0\.34/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideMaxLumaDelta, 7/);
  assert.match(rescueSource, /outlineEscalationBodyOverrideHardSceneGuard, 0\.50/);
  assert.doesNotMatch(rescueSource, /outlineEscalationStrength, 0\.[6-9]/);
});

test('batch diagnostics expose the exact scene/body sub-gate that blocks rescue', () => {
  assert.match(previewSource, /outline-partial-evidence-blocked/);
  assert.match(previewSource, /outline-partial-safe-coverage-blocked/);
  assert.match(previewSource, /outline-partial-global-complexity-blocked/);
  assert.match(previewSource, /outline-partial-localization-blocked/);
  assert.match(previewSource, /outline-body-outline-evidence-blocked/);
  assert.match(previewSource, /outline-body-score-blocked/);
  assert.match(previewSource, /outline-body-dominance-blocked/);
});

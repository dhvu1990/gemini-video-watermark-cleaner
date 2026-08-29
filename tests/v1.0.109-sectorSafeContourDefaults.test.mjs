import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');

test('production outline rescue allows sector-safe partial completion without global gain changes', () => {
  assert.match(source, /outlineEscalationMaxSceneGuardedRatio, 0\.52/);
  assert.match(source, /outlineEscalationMaxPartialSceneGuardedRatio, 0\.52/);
  assert.match(source, /outlineEscalationPartialMinSafeContourRatio, 0\.48/);
  assert.match(source, /outlineEscalationPartialMinSafeSampleDensity, 0\.035/);
});

test('production body override remains contour-only and bounded', () => {
  assert.match(source, /outlineEscalationBodyOverrideMinScore, 1\.25/);
  assert.match(source, /outlineEscalationBodyOverrideMinSectorSupport, 3/);
  assert.match(source, /outlineEscalationBodyOverrideMaxBodyScore, 8\.0/);
  assert.match(source, /outlineEscalationBodyOverrideMinDominance, 0\.30/);
  assert.doesNotMatch(source, /outlineEscalationStrength, 0\.[6-9]/);
});

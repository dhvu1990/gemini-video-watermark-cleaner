import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/video/structuredSmoothRescue.js', import.meta.url), 'utf8');

test('later guarded contour tuning preserves the v1.0.109 no-global-gain invariant', () => {
  assert.match(source, /outlineEscalationStrength, 0\.58/);
  assert.match(source, /outlineEscalationPartialSceneProtection !== false/);
  assert.match(source, /outlineEscalationContourBodyOverride !== false/);
  assert.doesNotMatch(source, /outlineEscalationStrength, 0\.[6-9]/);
});

test('later guarded contour tuning keeps partial and body override corrections below the normal pass', () => {
  assert.match(source, /outlineEscalationPartialStrength, 0\.46/);
  assert.match(source, /outlineEscalationPartialMaxBlend, 0\.36/);
  assert.match(source, /outlineEscalationBodyOverrideStrength, 0\.44/);
  assert.match(source, /outlineEscalationBodyOverrideMaxBlend, 0\.34/);
});

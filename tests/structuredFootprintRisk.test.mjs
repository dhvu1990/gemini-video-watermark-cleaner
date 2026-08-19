import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStructuredFootprintRisk } from '../src/video/structuredFootprintRisk.js';

test('classifies dense low-continuity footprint evidence as strong', () => {
  const risk = classifyStructuredFootprintRisk({
    score: 1.843,
    rawScore: 3.125,
    coverage: 0.071,
    shapeAlignedDensity: 0.044,
    continuityMean: 0.318,
    samples: 84,
    candidateSamples: 240
  });
  assert.equal(risk.level, 'strong');
  assert.ok(risk.evidence >= 0.68);
  assert.equal(risk.provisional, true);
  assert.match(risk.reason, /shape-score/);
});

test('classifies borderline multi-signal footprint evidence as suspect', () => {
  const risk = classifyStructuredFootprintRisk({
    score: 0.92,
    rawScore: 1.28,
    coverage: 0.021,
    shapeAlignedDensity: 0.009,
    continuityMean: 0.38,
    samples: 38,
    candidateSamples: 150
  });
  assert.equal(risk.level, 'suspect');
  assert.ok(risk.evidence >= 0.38);
  assert.ok(risk.evidence < 0.68);
});

test('keeps clean low-shape telemetry clear', () => {
  const risk = classifyStructuredFootprintRisk({
    score: 0.34,
    rawScore: 0.61,
    coverage: 0.010,
    shapeAlignedDensity: 0.0015,
    continuityMean: 0.20,
    samples: 29,
    candidateSamples: 120
  });
  assert.equal(risk.level, 'clear');
});

test('continuing real-scene structure prevents strong classification', () => {
  const risk = classifyStructuredFootprintRisk({
    score: 1.45,
    rawScore: 4.30,
    coverage: 0.060,
    shapeAlignedDensity: 0.030,
    continuityMean: 0.78,
    samples: 92,
    candidateSamples: 260
  });
  assert.notEqual(risk.level, 'strong');
  assert.match(risk.reason, /scene-continuity/);
});

test('does not classify sparse measurements', () => {
  const risk = classifyStructuredFootprintRisk({
    score: 3.0,
    rawScore: 3.1,
    coverage: 0.04,
    shapeAlignedDensity: 0.03,
    continuityMean: 0.1,
    samples: 4,
    candidateSamples: 8
  });
  assert.equal(risk.level, 'insufficient');
  assert.equal(risk.evidence, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStructuredFootprintRisk, STRUCTURED_FOOTPRINT_RISK_THRESHOLDS } from '../src/video/structuredFootprintRisk.js';

test('flags the validated heavy structured footprint sample conservatively', () => {
  const result = evaluateStructuredFootprintRisk({
    score: 1.835,
    rawScore: 2.170,
    coverage: 0.170,
    shapeAlignedDensity: 0.096,
    continuityMean: 0.229
  });
  assert.equal(result.triggered, true);
  assert.equal(result.level, 'strong');
  assert.deepEqual(result.flags, ['structured-footprint-strong']);
  assert.equal(result.reason, 'strong-structured-footprint');
});

test('does not flag a footprint-like score when coverage is too small', () => {
  const result = evaluateStructuredFootprintRisk({
    score: 1.92,
    rawScore: 2.30,
    coverage: 0.041,
    shapeAlignedDensity: 0.031,
    continuityMean: 0.20
  });
  assert.equal(result.triggered, false);
  assert.deepEqual(result.flags, []);
});

test('does not flag scene-edge dominated telemetry with high continuity', () => {
  const result = evaluateStructuredFootprintRisk({
    score: 1.74,
    rawScore: 2.22,
    coverage: 0.16,
    shapeAlignedDensity: 0.082,
    continuityMean: 0.71
  });
  assert.equal(result.triggered, false);
  assert.equal(result.gates.continuity, false);
});

test('keeps incomplete telemetry non-triggering', () => {
  const result = evaluateStructuredFootprintRisk({ score: 1.9, rawScore: 2.1 });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'insufficient-metric');
  assert.equal(result.gates, null);
});

test('exports stable conservative default thresholds', () => {
  assert.deepEqual(STRUCTURED_FOOTPRINT_RISK_THRESHOLDS, {
    minScore: 1.60,
    minRawScore: 1.90,
    minCoverage: 0.10,
    minShapeAlignedDensity: 0.05,
    maxContinuityMean: 0.50
  });
});

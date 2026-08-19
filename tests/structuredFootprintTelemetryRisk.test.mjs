import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAntiStreakTelemetry } from '../src/antiStreakTelemetryFormat.js';

test('preview telemetry surfaces the strong structured footprint flag for the validated real sample', () => {
  const formatted = formatAntiStreakTelemetry({
    riskFlags: [],
    structured: {
      attempted: true,
      accepted: true,
      acceptedMode: 'primary+shape-ghost',
      alignedBeforeScore: 1.720,
      alignedAfterScore: 1.546,
      alignedSampleDensity: 0.048,
      alignedImprovement: 0.101,
      footprint: {
        score: 1.835,
        rawScore: 2.170,
        coverage: 0.170,
        shapeAlignedDensity: 0.096,
        continuityMean: 0.229
      }
    }
  });

  assert.equal(formatted.riskFlags, 'structured-footprint-strong');
  assert.equal(formatted.footprintRisk, 'strong');
  assert.equal(formatted.footprintRiskReason, 'strong-structured-footprint');
});

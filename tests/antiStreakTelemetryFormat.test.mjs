import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAntiStreakExportSummary, formatAntiStreakTelemetry } from '../src/antiStreakTelemetryFormat.js';

test('formats preview anti-streak telemetry for structured residual investigation', () => {
  const formatted = formatAntiStreakTelemetry({
    temporalDonor: { attempted: true, accepted: false, reason: 'residual-safety-gate', guardedRatio: 0.375, meanStructureMismatch: 0.4284, totalRatio: 1.0112 },
    atlas: { donorCount: 3, meanConfidence: 0.7123, meanDonorSpread: 21.456 },
    structured: {
      attempted: true, accepted: false, acceptedMode: 'none', alignedBeforeScore: 2.315, alignedAfterScore: 2.281, alignedSampleDensity: 0.0185, alignedImprovement: 0.0147,
      footprint: { score: 1.8426, rawScore: 3.1254, coverage: 0.0712, shapeAlignedDensity: 0.0438, continuityMean: 0.318, samples: 84, candidateSamples: 240 },
      highContrastAdjacency: { score: 0.6842, edgeDensity: 0.121, straddleDensity: 0.034, meanContrast: 12.456, p90Contrast: 24.75, shapeAlignment: 0.283, level: 'high', reason: 'dense-high-contrast-mask-adjacency' }
    },
    riskFlags: ['temporal-donor-rejected', 'high-donor-spread', 'dense-structured-ring-residual', 'high-contrast-adjacency']
  });
  assert.equal(formatted.riskFlags, 'temporal-donor-rejected, high-donor-spread, dense-structured-ring-residual, high-contrast-adjacency');
  assert.equal(formatted.donorAttempted, 'YES'); assert.equal(formatted.donorAccepted, 'NO'); assert.equal(formatted.donorGuardedRatio, '37.5%'); assert.equal(formatted.donorStructureMismatch, '0.428'); assert.equal(formatted.donorTotalRatio, '1.0112'); assert.equal(formatted.atlasDonors, '3'); assert.equal(formatted.atlasDonorSpread, '21.46'); assert.equal(formatted.structuredBefore, '2.315'); assert.equal(formatted.structuredDensity, '1.8%'); assert.equal(formatted.structuredImprovement, '1.5%');
  assert.equal(formatted.footprintScore, '1.843'); assert.equal(formatted.footprintRawScore, '3.125'); assert.equal(formatted.footprintCoverage, '7.1%'); assert.equal(formatted.footprintShapeDensity, '4.4%'); assert.equal(formatted.footprintContinuity, '31.8%'); assert.equal(formatted.footprintClass, 'STRONG'); assert.notEqual(formatted.footprintEvidence, '-'); assert.match(formatted.footprintReason, /shape-score/);
  assert.equal(formatted.adjacencyScore, '0.684'); assert.equal(formatted.adjacencyEdgeDensity, '12.1%'); assert.equal(formatted.adjacencyStraddleDensity, '3.4%'); assert.equal(formatted.adjacencyMeanContrast, '12.46'); assert.equal(formatted.adjacencyP90Contrast, '24.75'); assert.equal(formatted.adjacencyShapeAlignment, '28.3%'); assert.equal(formatted.adjacencyLevel, 'HIGH'); assert.equal(formatted.adjacencyReason, 'dense-high-contrast-mask-adjacency');
});

test('uses stable empty-state values when telemetry is absent', () => {
  const formatted = formatAntiStreakTelemetry(null);
  assert.equal(formatted.riskFlags, 'none'); assert.equal(formatted.donorAttempted, '-'); assert.equal(formatted.atlasDonors, '-'); assert.equal(formatted.structuredMode, 'none'); assert.equal(formatted.footprintScore, '-'); assert.equal(formatted.footprintClass, '-'); assert.equal(formatted.footprintEvidence, '-'); assert.equal(formatted.adjacencyScore, '-'); assert.equal(formatted.adjacencyLevel, '-');
});

test('formats export risk counters in descending frequency order', () => {
  const formatted = formatAntiStreakExportSummary({ antiStreakRiskFrames: 7, antiStreakRiskFlagCounts: { 'dense-structured-ring-residual': 5, 'high-donor-spread': 2, 'temporal-donor-rejected': 3 } });
  assert.equal(formatted.riskFrames, 7);
  assert.equal(formatted.flags, 'dense-structured-ring-residual:5, temporal-donor-rejected:3, high-donor-spread:2');
});

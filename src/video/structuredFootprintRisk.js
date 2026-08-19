const DEFAULT_THRESHOLDS = Object.freeze({
  minScore: 1.60,
  minRawScore: 1.90,
  minCoverage: 0.10,
  minShapeAlignedDensity: 0.05,
  maxContinuityMean: 0.50
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function threshold(options, key) {
  const value = finite(options?.[key]);
  return value === null ? DEFAULT_THRESHOLDS[key] : value;
}

export function evaluateStructuredFootprintRisk(metric = null, options = {}) {
  const score = finite(metric?.score);
  const rawScore = finite(metric?.rawScore);
  const coverage = finite(metric?.coverage);
  const shapeAlignedDensity = finite(metric?.shapeAlignedDensity);
  const continuityMean = finite(metric?.continuityMean);
  const thresholds = {
    minScore: threshold(options, 'minScore'),
    minRawScore: threshold(options, 'minRawScore'),
    minCoverage: threshold(options, 'minCoverage'),
    minShapeAlignedDensity: threshold(options, 'minShapeAlignedDensity'),
    maxContinuityMean: threshold(options, 'maxContinuityMean')
  };

  const complete = [score, rawScore, coverage, shapeAlignedDensity, continuityMean]
    .every((value) => value !== null);
  if (!complete) {
    return {
      triggered: false,
      level: 'none',
      reason: 'insufficient-metric',
      flags: [],
      thresholds,
      gates: null
    };
  }

  const gates = {
    score: score >= thresholds.minScore,
    rawScore: rawScore >= thresholds.minRawScore,
    coverage: coverage >= thresholds.minCoverage,
    shapeAlignedDensity: shapeAlignedDensity >= thresholds.minShapeAlignedDensity,
    continuity: continuityMean <= thresholds.maxContinuityMean
  };
  const triggered = Object.values(gates).every(Boolean);

  return {
    triggered,
    level: triggered ? 'strong' : 'none',
    reason: triggered ? 'strong-structured-footprint' : 'below-conservative-threshold',
    flags: triggered ? ['structured-footprint-strong'] : [],
    thresholds,
    gates
  };
}

export { DEFAULT_THRESHOLDS as STRUCTURED_FOOTPRINT_RISK_THRESHOLDS };

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export const STRUCTURED_FOOTPRINT_RISK_THRESHOLDS = Object.freeze({
  strong: Object.freeze({ score: 1.25, shapeAlignedDensity: 0.012, coverage: 0.018, maxContinuity: 0.55, evidence: 0.68 }),
  suspect: Object.freeze({ score: 0.70, shapeAlignedDensity: 0.004, coverage: 0.008, maxContinuity: 0.72, evidence: 0.38 }),
  minimumSamples: 8,
  minimumCandidateSamples: 12
});

export function classifyStructuredFootprintRisk(metric = null, options = {}) {
  const thresholds = options.thresholds || STRUCTURED_FOOTPRINT_RISK_THRESHOLDS;
  const score = finite(metric?.score);
  const rawScore = finite(metric?.rawScore);
  const coverage = finite(metric?.coverage);
  const shapeAlignedDensity = finite(metric?.shapeAlignedDensity);
  const continuityMean = clamp(finite(metric?.continuityMean), 0, 1);
  const samples = Math.max(0, Math.round(finite(metric?.samples)));
  const candidateSamples = Math.max(0, Math.round(finite(metric?.candidateSamples)));

  if (!metric || samples < thresholds.minimumSamples || candidateSamples < thresholds.minimumCandidateSamples) {
    return {
      level: 'insufficient',
      evidence: 0,
      provisional: true,
      reason: 'insufficient-footprint-samples',
      signals: { score: 0, density: 0, coverage: 0, retainedRatio: 0, continuity: continuityMean },
      thresholds
    };
  }

  const retainedRatio = rawScore > 1e-6 ? clamp(score / rawScore, 0, 1) : (score > 0 ? 1 : 0);
  const scoreSignal = smoothstep(0.55, 1.60, score);
  const densitySignal = smoothstep(0.0025, 0.024, shapeAlignedDensity);
  const coverageSignal = smoothstep(0.006, 0.050, coverage);
  const retainedSignal = smoothstep(0.28, 0.72, retainedRatio);
  const continuityConfidence = 1 - smoothstep(0.48, 0.82, continuityMean);
  const baseEvidence = scoreSignal * 0.42 + densitySignal * 0.28 + coverageSignal * 0.16 + retainedSignal * 0.14;
  const evidence = clamp(baseEvidence * (0.78 + continuityConfidence * 0.22), 0, 1);

  const strong = thresholds.strong;
  const suspect = thresholds.suspect;
  const isStrong = score >= strong.score
    && shapeAlignedDensity >= strong.shapeAlignedDensity
    && coverage >= strong.coverage
    && continuityMean <= strong.maxContinuity
    && evidence >= strong.evidence;
  const isSuspect = score >= suspect.score
    && shapeAlignedDensity >= suspect.shapeAlignedDensity
    && coverage >= suspect.coverage
    && continuityMean <= suspect.maxContinuity
    && evidence >= suspect.evidence;

  const level = isStrong ? 'strong' : (isSuspect ? 'suspect' : 'clear');
  const reasons = [];
  if (score >= suspect.score) reasons.push('shape-score');
  if (shapeAlignedDensity >= suspect.shapeAlignedDensity) reasons.push('shape-density');
  if (coverage >= suspect.coverage) reasons.push('coverage');
  if (continuityMean > suspect.maxContinuity) reasons.push('scene-continuity');
  if (retainedRatio < 0.35 && rawScore > suspect.score) reasons.push('continuity-discounted');

  return {
    level,
    evidence,
    provisional: true,
    reason: reasons.length ? reasons.join('+') : 'below-provisional-thresholds',
    signals: {
      score: scoreSignal,
      density: densitySignal,
      coverage: coverageSignal,
      retainedRatio,
      continuity: continuityMean
    },
    thresholds
  };
}

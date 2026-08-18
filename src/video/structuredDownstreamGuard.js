function finiteOr(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function safeRatio(value, baseline, fallback = 1) {
  const base = finiteOr(baseline, 0);
  if (Math.abs(base) <= 1e-9) return fallback;
  return finiteOr(value, base) / base;
}

export function evaluateStructuredDownstreamGuard({
  ringAccepted = false,
  alignedBeforeScore = 0,
  alignedBaselineScore = 0,
  alignedSampleDensity = 0,
  alignedImprovement = 0,
  baselineGlobal = null,
  finalAligned = null,
  finalGlobal = null,
  downstreamAccepted = false
} = {}, options = {}) {
  const enabled = options.enabled !== false;
  const minBeforeScore = Number.isFinite(options.minBeforeScore) ? options.minBeforeScore : 1.45;
  const minDensity = Number.isFinite(options.minDensity) ? options.minDensity : 0.03;
  const maxRingImprovement = Number.isFinite(options.maxRingImprovement) ? options.maxRingImprovement : 0.08;
  const maxAlignedRatio = Number.isFinite(options.maxAlignedRatio) ? options.maxAlignedRatio : 1.015;
  const maxTotalRatio = Number.isFinite(options.maxTotalRatio) ? options.maxTotalRatio : 1.006;
  const maxLumaRatio = Number.isFinite(options.maxLumaRatio) ? options.maxLumaRatio : 1.010;
  const maxChromaRatio = Number.isFinite(options.maxChromaRatio) ? options.maxChromaRatio : 1.012;

  const eligible = Boolean(
    enabled
    && ringAccepted
    && downstreamAccepted
    && finiteOr(alignedBeforeScore, 0) >= minBeforeScore
    && finiteOr(alignedSampleDensity, 0) >= minDensity
    && finiteOr(alignedImprovement, 0) < maxRingImprovement
  );

  const alignedRatio = safeRatio(finalAligned?.score, alignedBaselineScore, 1);
  const totalRatio = safeRatio(finalGlobal?.total, baselineGlobal?.total, 1);
  const lumaRatio = safeRatio(finalGlobal?.luma, baselineGlobal?.luma, 1);
  const chromaRatio = safeRatio(finalGlobal?.chroma, baselineGlobal?.chroma, 1);

  const failedGates = [];
  if (alignedRatio > maxAlignedRatio) failedGates.push('aligned');
  if (totalRatio > maxTotalRatio) failedGates.push('total');
  if (lumaRatio > maxLumaRatio) failedGates.push('luma');
  if (chromaRatio > maxChromaRatio) failedGates.push('chroma');

  const rollback = eligible && failedGates.length > 0;
  return {
    enabled,
    eligible,
    rollback,
    reason: !enabled
      ? 'disabled'
      : !ringAccepted
        ? 'ring-not-accepted'
        : !downstreamAccepted
          ? 'no-downstream-acceptance'
          : !eligible
            ? 'not-low-gain-eligible'
            : rollback
              ? 'downstream-safety-gate'
              : 'safe',
    failedGates,
    thresholds: {
      minBeforeScore,
      minDensity,
      maxRingImprovement,
      maxAlignedRatio,
      maxTotalRatio,
      maxLumaRatio,
      maxChromaRatio
    },
    alignedRatio,
    totalRatio,
    lumaRatio,
    chromaRatio
  };
}

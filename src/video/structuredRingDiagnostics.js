function finiteOr(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function stageSummary(stage = {}) {
  return {
    enabled: stage?.enabled !== false,
    attempted: Boolean(stage?.attempted),
    accepted: Boolean(stage?.accepted)
  };
}

export function summarizeStructuredRingDiagnostics(structuredRing = {}, pixelCount = 0) {
  const alignedBefore = structuredRing?.alignedBefore || {};
  const guard = structuredRing?.downstreamGuard || {};
  const selectedAligned = guard.rollback
    ? (guard.baselineAligned || structuredRing?.alignedAfter || alignedBefore)
    : (guard.finalAligned || structuredRing?.alignedAfter || alignedBefore);
  const beforeScore = Math.max(0, finiteOr(alignedBefore.score, 0));
  const afterScore = Math.max(0, finiteOr(selectedAligned.score, beforeScore));
  const samples = Math.max(0, Math.round(finiteOr(alignedBefore.samples, 0)));
  const safePixelCount = Math.max(0, Math.round(finiteOr(pixelCount, 0)));
  const sampleDensity = safePixelCount > 0 ? Math.min(1, samples / safePixelCount) : 0;
  const alignedImprovement = beforeScore > 1e-9
    ? (beforeScore - afterScore) / beforeScore
    : 0;

  return {
    enabled: structuredRing?.enabled !== false,
    attempted: Boolean(structuredRing?.attempted),
    accepted: Boolean(structuredRing?.accepted),
    ringAccepted: Boolean(structuredRing?.ringAccepted),
    acceptedMode: structuredRing?.acceptedMode || 'none',
    alignedBeforeScore: beforeScore,
    alignedAfterScore: afterScore,
    alignedSampleCount: samples,
    alignedSampleDensity: sampleDensity,
    alignedImprovement,
    correctedPixels: Math.max(0, Math.round(finiteOr(structuredRing?.correctedPixels, 0))),
    candidatePixels: Math.max(0, Math.round(finiteOr(structuredRing?.candidatePixels, 0))),
    salvageAttempted: Boolean(structuredRing?.salvageAttempted),
    salvageAccepted: Boolean(structuredRing?.salvageAccepted),
    downstreamGuard: {
      enabled: guard.enabled !== false,
      eligible: Boolean(guard.eligible),
      rollback: Boolean(guard.rollback),
      replayedBaseline: Boolean(guard.replayedBaseline),
      reason: guard.reason || 'not-run',
      failedGates: Array.isArray(guard.failedGates) ? [...guard.failedGates] : [],
      rolledBackMode: guard.rolledBackMode || 'none',
      alignedRatio: finiteOr(guard.alignedRatio, 1),
      totalRatio: finiteOr(guard.totalRatio, 1),
      lumaRatio: finiteOr(guard.lumaRatio, 1),
      chromaRatio: finiteOr(guard.chromaRatio, 1)
    },
    consensus: stageSummary(structuredRing?.consensus),
    shapeGhost: stageSummary(structuredRing?.shapeGhost),
    centerSeam: stageSummary(structuredRing?.centerSeam),
    localToneMatch: stageSummary(structuredRing?.localToneMatch),
    outerHalo: stageSummary(structuredRing?.outerHalo)
  };
}

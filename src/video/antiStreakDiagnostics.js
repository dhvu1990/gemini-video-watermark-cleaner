function finiteOr(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finiteOr(value, 0)));
}

export function summarizeAntiStreakDiagnostics({
  temporalDonorAcceptance = null,
  temporalDonor = null,
  atlas = null,
  structuredRingDiagnostics = null
} = {}) {
  const attempted = Boolean(temporalDonorAcceptance?.attempted);
  const accepted = Boolean(temporalDonorAcceptance?.accepted);
  const candidatePixels = Math.max(0, Math.round(finiteOr(temporalDonor?.candidatePixels, 0)));
  const guardedPixels = Math.max(0, Math.round(finiteOr(temporalDonor?.guardedPixels, 0)));
  const guardedRatio = candidatePixels > 0 ? Math.min(1, guardedPixels / candidatePixels) : 0;

  const atlasDonorCount = Math.max(0, Math.round(finiteOr(atlas?.donorCount, 0)));
  const atlasSupportedPixels = Math.max(0, Math.round(finiteOr(atlas?.supportedPixels, 0)));
  const atlasMeanConfidence = clamp01(atlas?.meanConfidence);
  const atlasMeanDonorSpread = Math.max(0, finiteOr(atlas?.meanDonorSpread, 0));

  const ring = structuredRingDiagnostics || {};
  const alignedBeforeScore = Math.max(0, finiteOr(ring.alignedBeforeScore, 0));
  const alignedAfterScore = Math.max(0, finiteOr(ring.alignedAfterScore, alignedBeforeScore));
  const alignedSampleDensity = clamp01(ring.alignedSampleDensity);

  const riskFlags = [];
  if (attempted && !accepted) riskFlags.push('temporal-donor-rejected');
  if (guardedRatio >= 0.25) riskFlags.push('temporal-donor-structure-guard-active');
  if (atlasDonorCount >= 2 && atlasMeanDonorSpread >= 18) riskFlags.push('high-donor-spread');
  if (alignedBeforeScore >= 1.75 && alignedSampleDensity >= 0.012) riskFlags.push('dense-structured-ring-residual');
  if (ring.attempted && !ring.accepted && alignedAfterScore >= alignedBeforeScore * 0.985) {
    riskFlags.push('structured-cleanup-low-gain');
  }

  return {
    temporalDonor: {
      attempted,
      accepted,
      rejected: attempted && !accepted,
      reason: temporalDonorAcceptance?.reason || (attempted ? 'unknown' : 'not-attempted'),
      totalRatio: finiteOr(temporalDonorAcceptance?.totalRatio, 1),
      lumaRatio: finiteOr(temporalDonorAcceptance?.lumaRatio, 1),
      chromaRatio: finiteOr(temporalDonorAcceptance?.chromaRatio, 1),
      candidatePixels,
      correctedPixels: Math.max(0, Math.round(finiteOr(temporalDonor?.correctedPixels, 0))),
      guardedPixels,
      guardedRatio,
      meanStructureConfidence: clamp01(temporalDonor?.meanStructureConfidence ?? 1),
      meanStructureMismatch: clamp01(temporalDonor?.meanStructureMismatch)
    },
    atlas: {
      donorCount: atlasDonorCount,
      supportedPixels: atlasSupportedPixels,
      meanConfidence: atlasMeanConfidence,
      meanDonorSpread: atlasMeanDonorSpread,
      allowMaskedDonors: Boolean(atlas?.allowMaskedDonors)
    },
    structured: {
      attempted: Boolean(ring.attempted),
      accepted: Boolean(ring.accepted),
      acceptedMode: ring.acceptedMode || 'none',
      alignedBeforeScore,
      alignedAfterScore,
      alignedSampleDensity,
      alignedImprovement: finiteOr(ring.alignedImprovement, 0),
      consensusAccepted: Boolean(ring.consensus?.accepted),
      shapeGhostAccepted: Boolean(ring.shapeGhost?.accepted),
      centerSeamAccepted: Boolean(ring.centerSeam?.accepted),
      localToneMatchAccepted: Boolean(ring.localToneMatch?.accepted),
      outerHaloAccepted: Boolean(ring.outerHalo?.accepted)
    },
    riskFlags
  };
}

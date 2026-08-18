function finiteOr(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function candidateIdentity(candidate = {}) {
  return {
    profile: candidate.profile ?? null,
    shapeScale: candidate.shapeScale ?? null,
    edgeBoost: candidate.edgeBoost ?? null,
    edgeGain: candidate.edgeGain ?? null,
    offsetX: candidate.offsetX ?? null,
    offsetY: candidate.offsetY ?? null,
    bodyGain: candidate.bodyGain ?? null
  };
}

function sameCandidateIdentity(left, right) {
  if (!left || !right) return false;
  const a = candidateIdentity(left);
  const b = candidateIdentity(right);
  return Object.keys(a).every((key) => a[key] === b[key]);
}

export function summarizeCalibrationRerank(reranked = {}) {
  const evaluated = Array.isArray(reranked.evaluated) ? reranked.evaluated : [];
  const selected = reranked.selected || null;
  const bestBase = evaluated.reduce((best, candidate) => {
    const score = finiteOr(candidate?.selectionScore, Number.POSITIVE_INFINITY);
    if (!best || score < best.selectionScore) return { candidate, selectionScore: score };
    return best;
  }, null);

  const selectedBaseScore = finiteOr(selected?.selectionScore, 0);
  const selectedFinalScore = finiteOr(selected?.finalScore, selectedBaseScore);
  const selectedArtifactScore = finiteOr(selected?.artifactResidual?.score, 0);
  const selectedArtifactCoverage = finiteOr(selected?.artifactResidual?.coverage, 0);
  const baseWinner = bestBase?.candidate || null;
  const baseWinnerScore = bestBase ? finiteOr(bestBase.selectionScore, 0) : 0;

  return {
    topN: finiteOr(reranked.topN, evaluated.length),
    inputCount: finiteOr(reranked.inputCount, 0),
    uniqueCount: finiteOr(reranked.uniqueCount, 0),
    duplicateCount: finiteOr(reranked.duplicateCount, 0),
    eligibleCount: finiteOr(reranked.eligibleCount, evaluated.length),
    excludedByGap: finiteOr(reranked.excludedByGap, 0),
    bestSelectionScore: finiteOr(reranked.bestSelectionScore, baseWinnerScore),
    maxRelativeGap: finiteOr(reranked.maxRelativeGap, 0),
    maxAbsoluteGap: finiteOr(reranked.maxAbsoluteGap, 0),
    minCoverage: finiteOr(reranked.minCoverage, 0),
    selectedChangedFromBase: Boolean(selected && baseWinner && !sameCandidateIdentity(selected, baseWinner)),
    selectedBaseScore,
    selectedFinalScore,
    selectedArtifactPenalty: Math.max(0, selectedFinalScore - selectedBaseScore),
    selectedArtifactScore,
    selectedArtifactCoverage,
    selectedArtifactCoverageEligible: Boolean(selected?.artifactCoverageEligible),
    selectedIdentity: selected ? candidateIdentity(selected) : null,
    baseWinnerIdentity: baseWinner ? candidateIdentity(baseWinner) : null,
    evaluated: evaluated.map((candidate) => {
      const selectionScore = finiteOr(candidate?.selectionScore, 0);
      const finalScore = finiteOr(candidate?.finalScore, selectionScore);
      return {
        ...candidateIdentity(candidate),
        selectionScore,
        finalScore,
        artifactPenalty: Math.max(0, finalScore - selectionScore),
        artifactScore: finiteOr(candidate?.artifactResidual?.score, 0),
        artifactCoverage: finiteOr(candidate?.artifactResidual?.coverage, 0),
        artifactCoverageEligible: Boolean(candidate?.artifactCoverageEligible)
      };
    })
  };
}

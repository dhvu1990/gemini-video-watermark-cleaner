function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function normalizeExactAnchorId(id) {
  return String(id || '').replace(/@[-\d]+,[-\d]+$/, '');
}

export function isExactAnchorId(id) {
  return /^veo-(?:1080p|720p|portrait-1080|portrait-720)-(?:standard|inset|relocated|compact|mini)$/.test(normalizeExactAnchorId(id));
}

export function calibrationEvidence(calibration, confidence = 0) {
  const improvement = Number(calibration?.improvement);
  const baseline = Number(calibration?.baselineScore);
  const residual = Number(calibration?.residualScore);
  const validScores = Number.isFinite(baseline) && baseline > 0 && Number.isFinite(residual);
  const residualRatio = validScores ? residual / baseline : Number.POSITIVE_INFINITY;
  const residualDrop = validScores ? Math.max(0, 1 - residualRatio) : 0;
  const safeImprovement = Number.isFinite(improvement) ? improvement : -1;
  const raw = clamp01(confidence);
  const eligible = validScores
    && safeImprovement >= 0.015
    && residualRatio <= 0.985;
  const quality = eligible
    ? safeImprovement * 0.72 + residualDrop * 0.24 + Math.min(raw, 0.25) * 0.04
    : Number.NEGATIVE_INFINITY;
  return {
    eligible,
    improvement: safeImprovement,
    baseline,
    residual,
    residualRatio,
    residualDrop,
    confidence: raw,
    quality
  };
}

export function selectExactAnchorCalibrationWinner(entries = []) {
  const evaluated = entries
    .map((entry, index) => ({
      ...entry,
      index,
      normalizedId: normalizeExactAnchorId(entry?.candidateId),
      evidence: calibrationEvidence(entry?.calibration, entry?.confidence)
    }))
    .filter((entry) => isExactAnchorId(entry.normalizedId));

  const eligible = evaluated
    .filter((entry) => entry.evidence.eligible)
    .sort((a, b) => b.evidence.quality - a.evidence.quality);

  if (!eligible.length) {
    return { safe: false, reason: 'exact-anchor-no-calibration-winner', evaluated };
  }

  const winner = eligible[0];
  const runnerUp = eligible[1] || null;
  if (runnerUp) {
    const qualityGap = winner.evidence.quality - runnerUp.evidence.quality;
    const improvementGap = winner.evidence.improvement - runnerUp.evidence.improvement;
    const ratioGap = runnerUp.evidence.residualRatio - winner.evidence.residualRatio;
    const decisive = qualityGap >= 0.008 || improvementGap >= 0.012 || ratioGap >= 0.012;
    if (!decisive) {
      return {
        safe: false,
        reason: 'exact-anchor-calibration-ambiguous',
        evaluated,
        winner,
        runnerUp,
        qualityGap,
        improvementGap,
        ratioGap
      };
    }
  }

  return {
    safe: true,
    reason: 'exact-anchor-calibration-winner',
    evaluated,
    winner,
    runnerUp,
    qualityGap: runnerUp ? winner.evidence.quality - runnerUp.evidence.quality : null,
    improvementGap: runnerUp ? winner.evidence.improvement - runnerUp.evidence.improvement : null,
    ratioGap: runnerUp ? runnerUp.evidence.residualRatio - winner.evidence.residualRatio : null
  };
}

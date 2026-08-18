function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function calibrationCandidateKey(candidate) {
  if (!candidate) return null;
  if (candidate.candidateKey != null) return `explicit:${String(candidate.candidateKey)}`;
  const fields = ['profile', 'shapeScale', 'edgeBoost', 'edgeGain', 'offsetX', 'offsetY', 'bodyGain'];
  const hasCalibrationIdentity = fields.some((field) => candidate[field] != null);
  if (!hasCalibrationIdentity) return null;
  return fields.map((field) => `${field}:${candidate[field] ?? ''}`).join('|');
}

function uniqueCalibrationCandidates(sortedCandidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of sortedCandidates) {
    const key = calibrationCandidateKey(candidate);
    if (key == null) {
      unique.push(candidate);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function nearTieCalibrationCandidates(sortedCandidates, options = {}) {
  if (!sortedCandidates.length) {
    return {
      candidates: [],
      bestSelectionScore: Number.POSITIVE_INFINITY,
      maxRelativeGap: 0,
      maxAbsoluteGap: 0
    };
  }

  const bestSelectionScore = Math.max(0, Number(sortedCandidates[0].selectionScore) || 0);
  const maxRelativeGap = clamp(
    Number.isFinite(Number(options.maxRelativeGap)) ? Number(options.maxRelativeGap) : 0.02,
    0,
    0.10
  );
  const maxAbsoluteGap = clamp(
    Number.isFinite(Number(options.maxAbsoluteGap)) ? Number(options.maxAbsoluteGap) : 0.20,
    0,
    5
  );

  const candidates = sortedCandidates.filter((candidate) => {
    const score = Math.max(0, Number(candidate.selectionScore) || 0);
    const absoluteGap = Math.max(0, score - bestSelectionScore);
    const relativeGap = bestSelectionScore > 1e-9
      ? absoluteGap / bestSelectionScore
      : (absoluteGap <= 1e-9 ? 0 : Number.POSITIVE_INFINITY);
    return absoluteGap <= maxAbsoluteGap + 1e-9 && relativeGap <= maxRelativeGap + 1e-9;
  });

  return { candidates, bestSelectionScore, maxRelativeGap, maxAbsoluteGap };
}

export function combineCalibrationArtifactScore(baseScore, artifact, options = {}) {
  const safeBase = Number.isFinite(baseScore) ? Math.max(0, baseScore) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(safeBase)) return Number.POSITIVE_INFINITY;
  const coverage = clamp(Number(artifact?.coverage) || 0, 0, 1);
  const artifactScore = Math.max(0, Number(artifact?.score) || 0);
  const minCoverage = clamp(
    Number.isFinite(Number(options.minCoverage)) ? Number(options.minCoverage) : 0.40,
    0,
    1
  );
  if (coverage < minCoverage || artifactScore <= 0) return safeBase;

  const artifactWeight = clamp(Number(options.artifactWeight ?? 0.055), 0, 0.20);
  const maxRelativePenalty = clamp(Number(options.maxRelativePenalty ?? 0.10), 0, 0.25);
  const rawPenalty = artifactScore * artifactWeight * coverage;
  const cappedPenalty = Math.min(rawPenalty, safeBase * maxRelativePenalty);
  return safeBase + cappedPenalty;
}

export async function rerankCalibrationCandidates(candidates, evaluateArtifact, options = {}) {
  const valid = (candidates || [])
    .filter((candidate) => candidate && Number.isFinite(candidate.selectionScore))
    .sort((a, b) => a.selectionScore - b.selectionScore);
  const minCoverage = clamp(
    Number.isFinite(Number(options.minCoverage)) ? Number(options.minCoverage) : 0.40,
    0,
    1
  );
  if (!valid.length) {
    return {
      selected: null,
      evaluated: [],
      topN: 0,
      inputCount: 0,
      uniqueCount: 0,
      duplicateCount: 0,
      eligibleCount: 0,
      excludedByGap: 0,
      bestSelectionScore: Number.POSITIVE_INFINITY,
      maxRelativeGap: 0,
      maxAbsoluteGap: 0,
      minCoverage
    };
  }

  const unique = uniqueCalibrationCandidates(valid);
  const nearTie = nearTieCalibrationCandidates(unique, options);
  const requestedTopN = Math.round(Number(options.topN ?? 4));
  const topN = Math.min(nearTie.candidates.length, clamp(requestedTopN || 4, 1, 6));
  const finalists = nearTie.candidates.slice(0, topN);
  const evaluated = [];

  for (let index = 0; index < finalists.length; index++) {
    const candidate = finalists[index];
    const artifact = typeof evaluateArtifact === 'function'
      ? await evaluateArtifact(candidate, index, finalists.length)
      : null;
    const finalScore = combineCalibrationArtifactScore(candidate.selectionScore, artifact, { ...options, minCoverage });
    evaluated.push({
      ...candidate,
      artifactResidual: artifact,
      artifactCoverageEligible: (Number(artifact?.coverage) || 0) >= minCoverage,
      finalScore
    });
  }

  evaluated.sort((a, b) => {
    if (Math.abs(a.finalScore - b.finalScore) > 1e-9) return a.finalScore - b.finalScore;
    return a.selectionScore - b.selectionScore;
  });

  return {
    selected: evaluated[0],
    evaluated,
    topN,
    inputCount: valid.length,
    uniqueCount: unique.length,
    duplicateCount: valid.length - unique.length,
    eligibleCount: nearTie.candidates.length,
    excludedByGap: unique.length - nearTie.candidates.length,
    bestSelectionScore: nearTie.bestSelectionScore,
    maxRelativeGap: nearTie.maxRelativeGap,
    maxAbsoluteGap: nearTie.maxAbsoluteGap,
    minCoverage
  };
}

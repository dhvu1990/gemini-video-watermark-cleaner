function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function combineCalibrationArtifactScore(baseScore, artifact, options = {}) {
  const safeBase = Number.isFinite(baseScore) ? Math.max(0, baseScore) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(safeBase)) return Number.POSITIVE_INFINITY;
  const coverage = clamp(Number(artifact?.coverage) || 0, 0, 1);
  const artifactScore = Math.max(0, Number(artifact?.score) || 0);
  if (coverage <= 0 || artifactScore <= 0) return safeBase;

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
  if (!valid.length) return { selected: null, evaluated: [], topN: 0 };

  const requestedTopN = Math.round(Number(options.topN ?? 4));
  const topN = Math.min(valid.length, clamp(requestedTopN || 4, 1, 6));
  const finalists = valid.slice(0, topN);
  const evaluated = [];

  for (let index = 0; index < finalists.length; index++) {
    const candidate = finalists[index];
    const artifact = typeof evaluateArtifact === 'function'
      ? await evaluateArtifact(candidate, index, finalists.length)
      : null;
    const finalScore = combineCalibrationArtifactScore(candidate.selectionScore, artifact, options);
    evaluated.push({ ...candidate, artifactResidual: artifact, finalScore });
  }

  evaluated.sort((a, b) => {
    if (Math.abs(a.finalScore - b.finalScore) > 1e-9) return a.finalScore - b.finalScore;
    return a.selectionScore - b.selectionScore;
  });

  return { selected: evaluated[0], evaluated, topN };
}

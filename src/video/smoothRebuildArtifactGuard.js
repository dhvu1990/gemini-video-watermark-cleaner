import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureProtectedResidualField } from './protectedResidualRescue.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ratioImprovement(before, after) {
  return before > 1e-9 ? (before - after) / before : 0;
}

export function evaluateSmoothRebuildArtifactGuard(beforeImage, candidateImage, alphaMap, options = {}) {
  const enabled = options.enabled !== false;
  const beforeField = measureProtectedResidualField(beforeImage, alphaMap, options.residualOptions || {});
  const afterField = measureProtectedResidualField(candidateImage, alphaMap, options.residualOptions || {});
  const beforeGlobal = measurePostCleanupResidual(beforeImage, alphaMap);
  const afterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const sceneEdge = measureCrossingSceneEdgeRisk(beforeImage, alphaMap, options.sceneEdgeOptions || {});

  const fieldImprovement = ratioImprovement(beforeField.score, afterField.score);
  const globalImprovement = ratioImprovement(beforeGlobal.total, afterGlobal.total);
  const minSamples = Math.max(8, Math.round(finite(options.minSamples, 16)));
  const minDensity = finite(options.minDensity, 0.10);
  const minResidualScore = finite(options.minResidualScore, 1.70);
  const minExpectedImprovement = finite(options.minExpectedImprovement, 0.22);
  const residualDense = afterField.samples >= minSamples
    && afterField.candidateDensity >= minDensity;
  const residualSuspicious = residualDense && afterField.score >= minResidualScore;
  const fieldRegression = residualSuspicious
    && afterField.score > beforeField.score * finite(options.maxFieldRatio, 1.06) + finite(options.fieldTolerance, 0.12);
  const lowGainSmooth = residualSuspicious && fieldImprovement < minExpectedImprovement;
  const sceneConflict = residualDense
    && sceneEdge.protect
    && afterField.score >= finite(options.sceneConflictScore, 1.10);
  const severeResidual = residualDense
    && afterField.score >= finite(options.severeResidualScore, 2.80)
    && afterField.candidateDensity >= finite(options.severeDensity, 0.16)
    && globalImprovement < finite(options.severeMinGlobalImprovement, 0.18);

  const rollback = enabled && (fieldRegression || lowGainSmooth || sceneConflict || severeResidual);
  let reason = 'accepted';
  if (!enabled) reason = 'disabled';
  else if (fieldRegression) reason = 'protected-residual-regression';
  else if (sceneConflict) reason = 'crossing-scene-edge-conflict';
  else if (severeResidual) reason = 'severe-post-rebuild-residual';
  else if (lowGainSmooth) reason = 'smooth-rebuild-low-gain';

  return {
    enabled,
    rollback,
    reason,
    beforeField,
    afterField,
    fieldImprovement,
    beforeGlobal,
    afterGlobal,
    globalImprovement,
    sceneEdge,
    residualDense,
    residualSuspicious,
    fieldRegression,
    lowGainSmooth,
    sceneConflict,
    severeResidual
  };
}

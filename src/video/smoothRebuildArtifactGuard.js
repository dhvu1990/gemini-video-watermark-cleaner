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

function lumaAt(image, x, y) {
  const index = (y * image.width + x) * 4;
  return 0.2126 * image.data[index]
    + 0.7152 * image.data[index + 1]
    + 0.0722 * image.data[index + 2];
}

function footprintChangeMetrics(beforeImage, candidateImage, alphaMap, options = {}) {
  if (!beforeImage?.data || !candidateImage?.data
    || beforeImage.width !== candidateImage.width
    || beforeImage.height !== candidateImage.height
    || alphaMap?.length !== beforeImage.width * beforeImage.height) {
    return {
      valid: false,
      samples: 0,
      gradientSamples: 0,
      meanAbsLumaDelta: 0,
      meanSignedLumaDelta: 0,
      darkShiftFraction: 0,
      severeDarkShiftFraction: 0,
      beforeEdgeEnergy: 0,
      afterEdgeEnergy: 0,
      edgeEnergyRatio: 1
    };
  }

  const minAlpha = finite(options.changeMinAlpha, 0.018);
  const darkShiftThreshold = finite(options.darkShiftThreshold, 8);
  const severeDarkShiftThreshold = finite(options.severeDarkShiftThreshold, 16);
  let samples = 0;
  let absDeltaSum = 0;
  let signedDeltaSum = 0;
  let darkShiftPixels = 0;
  let severeDarkShiftPixels = 0;
  let gradientSamples = 0;
  let beforeGradientSum = 0;
  let afterGradientSum = 0;

  for (let y = 0; y < beforeImage.height; y++) {
    for (let x = 0; x < beforeImage.width; x++) {
      const p = y * beforeImage.width + x;
      if ((alphaMap[p] || 0) < minAlpha) continue;
      const beforeY = lumaAt(beforeImage, x, y);
      const afterY = lumaAt(candidateImage, x, y);
      const delta = afterY - beforeY;
      samples++;
      absDeltaSum += Math.abs(delta);
      signedDeltaSum += delta;
      if (delta <= -darkShiftThreshold) darkShiftPixels++;
      if (delta <= -severeDarkShiftThreshold) severeDarkShiftPixels++;

      if (x < 1 || y < 1 || x >= beforeImage.width - 1 || y >= beforeImage.height - 1) continue;
      const beforeGradient = 0.5 * (
        Math.abs(lumaAt(beforeImage, x + 1, y) - lumaAt(beforeImage, x - 1, y))
        + Math.abs(lumaAt(beforeImage, x, y + 1) - lumaAt(beforeImage, x, y - 1))
      );
      const afterGradient = 0.5 * (
        Math.abs(lumaAt(candidateImage, x + 1, y) - lumaAt(candidateImage, x - 1, y))
        + Math.abs(lumaAt(candidateImage, x, y + 1) - lumaAt(candidateImage, x, y - 1))
      );
      beforeGradientSum += beforeGradient;
      afterGradientSum += afterGradient;
      gradientSamples++;
    }
  }

  const beforeEdgeEnergy = gradientSamples ? beforeGradientSum / gradientSamples : 0;
  const afterEdgeEnergy = gradientSamples ? afterGradientSum / gradientSamples : 0;
  return {
    valid: true,
    samples,
    gradientSamples,
    meanAbsLumaDelta: samples ? absDeltaSum / samples : 0,
    meanSignedLumaDelta: samples ? signedDeltaSum / samples : 0,
    darkShiftFraction: samples ? darkShiftPixels / samples : 0,
    severeDarkShiftFraction: samples ? severeDarkShiftPixels / samples : 0,
    beforeEdgeEnergy,
    afterEdgeEnergy,
    edgeEnergyRatio: beforeEdgeEnergy > 1e-9 ? afterEdgeEnergy / beforeEdgeEnergy : 1
  };
}

export function evaluateSmoothRebuildArtifactGuard(beforeImage, candidateImage, alphaMap, options = {}) {
  const enabled = options.enabled !== false;
  const beforeField = measureProtectedResidualField(beforeImage, alphaMap, options.residualOptions || {});
  const afterField = measureProtectedResidualField(candidateImage, alphaMap, options.residualOptions || {});
  const beforeGlobal = measurePostCleanupResidual(beforeImage, alphaMap);
  const afterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const sceneEdge = measureCrossingSceneEdgeRisk(beforeImage, alphaMap, options.sceneEdgeOptions || {});
  const change = footprintChangeMetrics(beforeImage, candidateImage, alphaMap, options);

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

  const minToneSamples = Math.max(8, Math.round(finite(options.minToneSamples, 16)));
  const destructiveToneShift = change.valid && change.samples >= minToneSamples && (
    change.meanAbsLumaDelta > finite(options.maxMeanAbsLumaDelta, 11)
    || (
      change.meanSignedLumaDelta < -finite(options.maxMeanDarkShift, 7)
      && change.darkShiftFraction > finite(options.maxDarkShiftFraction, 0.45)
    )
    || change.severeDarkShiftFraction > finite(options.maxSevereDarkShiftFraction, 0.28)
  );
  const structureCollapse = change.valid
    && change.gradientSamples >= Math.max(8, Math.round(finite(options.minStructureSamples, 16)))
    && change.beforeEdgeEnergy >= finite(options.minBeforeEdgeEnergy, 4)
    && change.edgeEnergyRatio < finite(options.minEdgeEnergyRatio, 0.52)
    && change.meanAbsLumaDelta >= finite(options.minStructureChange, 3.5);

  const residualChecksEnabled = options.residualChecksEnabled !== false;
  const residualRollback = residualChecksEnabled
    && (fieldRegression || lowGainSmooth || sceneConflict || severeResidual);
  const rollback = enabled && (residualRollback || destructiveToneShift || structureCollapse);
  let reason = 'accepted';
  if (!enabled) reason = 'disabled';
  else if (destructiveToneShift) reason = 'destructive-tone-shift';
  else if (structureCollapse) reason = 'structure-collapse';
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
    change,
    residualChecksEnabled,
    residualDense,
    residualSuspicious,
    fieldRegression,
    lowGainSmooth,
    sceneConflict,
    severeResidual,
    destructiveToneShift,
    structureCollapse
  };
}

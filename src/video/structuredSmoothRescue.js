import { applySmoothBackgroundReconstruction } from './smoothBackground.js';
import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureStructuredRingResidual } from './structuredRingSuppress.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';
import {
  applyProtectedResidualRescue,
  measureGeometricOutlineResidual
} from './protectedResidualRescue.js';
import { applyOutlineResidualEscalation } from './outlineResidualEscalation.js';
import { applyContourMicroInterpolation } from './contourMicroInterpolation.js';
import { evaluateSmoothRebuildArtifactGuard } from './smoothRebuildArtifactGuard.js';

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ratioImprovement(before, after) {
  return before > 1e-9 ? (before - after) / before : 0;
}

export function evaluateStructuredSmoothRescueEligibility(image, alphaMap, smoothAnalysis = {}, structuredRing = {}, options = {}) {
  const aligned = measureStructuredRingResidual(image, alphaMap);
  const density = alphaMap.length ? aligned.samples / alphaMap.length : 0;
  const priorBefore = finite(structuredRing?.alignedBefore?.score, aligned.score);
  const priorAfter = finite(structuredRing?.alignedAfter?.score, priorBefore);
  const priorImprovement = ratioImprovement(priorBefore, priorAfter);
  const sceneEdge = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});

  const residualStrong = aligned.score >= finite(options.minAlignedScore, 1.45)
    && density >= finite(options.minAlignedDensity, 0.018);
  const priorLowGain = priorImprovement <= finite(options.maxPriorImprovement, 0.10);

  const nearSmooth = Boolean(smoothAnalysis?.coefficients)
    && finite(smoothAnalysis.surfaceMae, Infinity) <= finite(options.maxSurfaceMae, 8.8)
    && finite(smoothAnalysis.edgeDensity, Infinity) <= finite(options.maxEdgeDensity, 0.090)
    && finite(smoothAnalysis.meanGradient, Infinity) <= finite(options.maxMeanGradient, 9.0)
    && finite(smoothAnalysis.meanLaplacian, Infinity) <= finite(options.maxMeanLaplacian, 6.8)
    && finite(smoothAnalysis.complexity, Infinity) <= finite(options.maxComplexity, 0.42);

  const sceneSafe = !sceneEdge.protect
    && sceneEdge.level !== 'high'
    && finite(sceneEdge.score, 1) <= finite(options.maxSceneEdgeScore, 0.30);

  return {
    eligible: options.enabled !== false && residualStrong && priorLowGain && nearSmooth && sceneSafe,
    residualStrong,
    priorLowGain,
    nearSmooth,
    sceneSafe,
    aligned,
    alignedDensity: density,
    priorImprovement,
    sceneEdge
  };
}

function finalResidualOptions(options = {}) {
  return {
    minScore: finite(options.finalResidualMinScore, 1.55),
    minDensity: finite(options.finalResidualMinDensity, 0.16),
    minSamples: Math.max(8, Math.round(finite(options.finalResidualMinSamples, 18))),
    minImprovement: finite(options.finalResidualMinImprovement, 0.02),
    strength: finite(options.finalResidualStrength, 0.44),
    maxBlend: finite(options.finalResidualMaxBlend, 0.38),
    maxLumaDelta: finite(options.finalResidualMaxLumaDelta, 10),
    hardSceneGuard: finite(options.finalResidualHardSceneGuard, 0.66),
    ...(options.finalResidualOptions || {})
  };
}

function outlineEscalationOptions(options = {}) {
  return {
    enabled: options.outlineEscalationEnabled !== false,
    minOutlineScore: finite(options.outlineEscalationMinScore, 1.15),
    minOutlineDensity: finite(options.outlineEscalationMinDensity, 0.075),
    minOutlineSamples: Math.max(8, Math.round(finite(options.outlineEscalationMinSamples, 12))),
    minSectorSupport: Math.max(3, Math.round(finite(options.outlineEscalationMinSectorSupport, 3))),
    minOutlineDominance: finite(options.outlineEscalationMinDominance, 0.82),
    maxBodyScore: finite(options.outlineEscalationMaxBodyScore, 2.35),
    maxBodyDensity: finite(options.outlineEscalationMaxBodyDensity, 0.38),
    maxSceneGuardedRatio: finite(options.outlineEscalationMaxSceneGuardedRatio, 0.68),
    strength: finite(options.outlineEscalationStrength, 0.58),
    maxBlend: finite(options.outlineEscalationMaxBlend, 0.48),
    maxLumaDelta: finite(options.outlineEscalationMaxLumaDelta, 11),
    hardSceneGuard: finite(options.outlineEscalationHardSceneGuard, 0.62),
    minImprovement: finite(options.outlineEscalationMinImprovement, 0.035),
    partialSceneProtection: options.outlineEscalationPartialSceneProtection !== false,
    maxPartialSceneGuardedRatio: finite(options.outlineEscalationMaxPartialSceneGuardedRatio, 0.68),
    partialMinOutlineScore: finite(options.outlineEscalationPartialMinScore, 1.18),
    partialMinOutlineDensity: finite(options.outlineEscalationPartialMinDensity, 0.075),
    partialMinOutlineSamples: Math.max(8, Math.round(finite(options.outlineEscalationPartialMinSamples, 12))),
    partialMinSafeContourRatio: finite(options.outlineEscalationPartialMinSafeContourRatio, 0.30),
    partialMinSafeContourPixels: Math.max(10, Math.round(finite(options.outlineEscalationPartialMinSafeContourPixels, 12))),
    partialMinSafeSampleDensity: finite(options.outlineEscalationPartialMinSafeSampleDensity, 0.025),
    maxPartialSceneEdgeDensity: finite(options.outlineEscalationMaxPartialSceneEdgeDensity, 0.42),
    maxPartialSceneEdgeContinuityDensity: finite(options.outlineEscalationMaxPartialSceneEdgeContinuityDensity, 0.34),
    partialStrength: finite(options.outlineEscalationPartialStrength, 0.46),
    partialMaxBlend: finite(options.outlineEscalationPartialMaxBlend, 0.36),
    partialMaxLumaDelta: finite(options.outlineEscalationPartialMaxLumaDelta, 8),
    partialHardSceneGuard: finite(options.outlineEscalationPartialHardSceneGuard, 0.44),
    partialMinImprovement: finite(options.outlineEscalationPartialMinImprovement, 0.012),
    partialMaxOutlineRatio: finite(options.outlineEscalationPartialMaxOutlineRatio, 0.988),
    contourBodyOverride: options.outlineEscalationContourBodyOverride !== false,
    bodyOverrideMinOutlineScore: finite(options.outlineEscalationBodyOverrideMinScore, 1.25),
    bodyOverrideMinOutlineDensity: finite(options.outlineEscalationBodyOverrideMinDensity, 0.075),
    bodyOverrideMinOutlineSamples: Math.max(8, Math.round(finite(options.outlineEscalationBodyOverrideMinSamples, 12))),
    bodyOverrideMinSectorSupport: Math.max(3, Math.round(finite(options.outlineEscalationBodyOverrideMinSectorSupport, 3))),
    bodyOverrideMaxBodyScore: finite(options.outlineEscalationBodyOverrideMaxBodyScore, 12.0),
    bodyOverrideMinDominance: finite(options.outlineEscalationBodyOverrideMinDominance, 0.20),
    bodyOverrideStrength: finite(options.outlineEscalationBodyOverrideStrength, 0.44),
    bodyOverrideMaxBlend: finite(options.outlineEscalationBodyOverrideMaxBlend, 0.34),
    bodyOverrideMaxLumaDelta: finite(options.outlineEscalationBodyOverrideMaxLumaDelta, 7),
    bodyOverrideHardSceneGuard: finite(options.outlineEscalationBodyOverrideHardSceneGuard, 0.50),
    bodyOverrideMinImprovement: finite(options.outlineEscalationBodyOverrideMinImprovement, 0.015),
    bodyOverrideMaxOutlineRatio: finite(options.outlineEscalationBodyOverrideMaxOutlineRatio, 0.985),
    conservativeMaxMeanBlend: finite(options.outlineEscalationConservativeMaxMeanBlend, 0.42),
    ...(options.outlineEscalationOptions || {})
  };
}

function microInterpolationOptions(options = {}) {
  return {
    enabled: options.contourMicroInterpolationEnabled !== false,
    minScore: finite(options.contourMicroInterpolationMinScore, 1.10),
    minDensity: finite(options.contourMicroInterpolationMinDensity, 0.055),
    minSamples: Math.max(8, Math.round(finite(options.contourMicroInterpolationMinSamples, 10))),
    minSectors: Math.max(2, Math.round(finite(options.contourMicroInterpolationMinSectors, 2))),
    minAlpha: finite(options.contourMicroInterpolationMinAlpha, 0.018),
    maxAlpha: finite(options.contourMicroInterpolationMaxAlpha, 0.28),
    cleanAlpha: finite(options.contourMicroInterpolationCleanAlpha, 0.014),
    maxRadius: Math.max(4, Math.round(finite(options.contourMicroInterpolationMaxRadius, 12))),
    hardSceneGuard: finite(options.contourMicroInterpolationHardSceneGuard, 0.40),
    strength: finite(options.contourMicroInterpolationStrength, 0.42),
    maxBlend: finite(options.contourMicroInterpolationMaxBlend, 0.30),
    maxLumaDelta: finite(options.contourMicroInterpolationMaxLumaDelta, 7),
    minCorrectedPixels: Math.max(4, Math.round(finite(options.contourMicroInterpolationMinCorrectedPixels, 6))),
    minImprovement: finite(options.contourMicroInterpolationMinImprovement, 0.006),
    maxOutlineRatio: finite(options.contourMicroInterpolationMaxOutlineRatio, 0.994),
    maxMeanBlend: finite(options.contourMicroInterpolationMaxMeanBlend, 0.28),
    sceneEdgeOptions: options.sceneEdgeOptions || {},
    ...(options.contourMicroInterpolationOptions || {})
  };
}

function measurePostChainOutlineResidual(image, alphaMap, options = {}) {
  const outlineOptions = outlineEscalationOptions(options);
  const residual = measureGeometricOutlineResidual(image, alphaMap, {
    ...outlineOptions,
    outlineMinAlpha: outlineOptions.minAlpha ?? 0.018,
    outlineMaxAlpha: outlineOptions.maxAlpha ?? 0.30,
    outlineResidualSoft: outlineOptions.residualSoft ?? 0.55,
    outlineResidualHard: outlineOptions.residualHard ?? 3.8
  });
  const strong = residual.score >= outlineOptions.minOutlineScore
    && residual.candidateDensity >= outlineOptions.minOutlineDensity
    && residual.samples >= outlineOptions.minOutlineSamples
    && residual.sectorSupport >= outlineOptions.minSectorSupport;
  return { ...residual, strong };
}

export function applyStructuredSmoothRescue(image, alphaMap, smoothAnalysis = {}, structuredRing = {}, options = {}) {
  const gate = evaluateStructuredSmoothRescueEligibility(image, alphaMap, smoothAnalysis, structuredRing, options);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const beforeAligned = gate.aligned;
  let structuredAttempted = false;
  let structuredMetricsAccepted = false;
  let structuredAccepted = false;
  let selected = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  let structuredCandidateGlobal = beforeGlobal;
  let structuredCandidateAligned = beforeAligned;
  let improvement = 0;
  let alignedImprovement = 0;
  let candidateSmoothBackground = null;
  let artifactGuard = null;
  const maxChromaIncrease = finite(options.maxChromaIncrease, 0.75);

  if (gate.eligible) {
    structuredAttempted = true;
    const candidate = applySmoothBackgroundReconstruction(
      image,
      alphaMap,
      {
        ...smoothAnalysis,
        safe: true,
        mode: 'smooth-rebuild',
        reason: `structured-smooth-rescue:${smoothAnalysis?.reason || 'near-smooth'}`
      },
      {
        strength: finite(options.strength, 0.86),
        dilationRadius: finite(options.dilationRadius, 3),
        microSmooth: finite(options.microSmooth, 0.10),
        preservationFallbackStrength: finite(options.fallbackStrength, 0.38),
        preservationFallbackDilation: finite(options.fallbackDilation, 2),
        preservationFallbackMicroSmooth: finite(options.fallbackMicroSmooth, 0.06),
        detailPreservationOptions: options.detailPreservationOptions || {}
      }
    );

    const candidateImage = { width: candidate.width, height: candidate.height, data: candidate.data };
    structuredCandidateGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
    structuredCandidateAligned = measureStructuredRingResidual(candidateImage, alphaMap);
    improvement = ratioImprovement(beforeGlobal.total, structuredCandidateGlobal.total);
    alignedImprovement = ratioImprovement(beforeAligned.score, structuredCandidateAligned.score);
    candidateSmoothBackground = candidate.smoothBackground || null;
    const detailAccepted = candidate.smoothBackground?.accepted !== false
      && candidate.smoothBackground?.detailPreservation?.accepted !== false;
    structuredMetricsAccepted = detailAccepted
      && alignedImprovement >= finite(options.minAlignedImprovement, 0.12)
      && structuredCandidateAligned.score <= beforeAligned.score * finite(options.maxAlignedRatio, 0.88)
      && structuredCandidateGlobal.total <= beforeGlobal.total * finite(options.maxTotalRatio, 0.992) + 0.02
      && structuredCandidateGlobal.luma <= beforeGlobal.luma * finite(options.maxLumaRatio, 0.995) + 0.03
      && structuredCandidateGlobal.chroma <= beforeGlobal.chroma * finite(options.maxChromaRatio, 1.01) + maxChromaIncrease;

    artifactGuard = evaluateSmoothRebuildArtifactGuard(
      image,
      candidateImage,
      alphaMap,
      options.artifactGuardOptions || {}
    );
    structuredAccepted = structuredMetricsAccepted && !artifactGuard.rollback;

    if (structuredAccepted) selected = candidateImage;
  }

  const finalCandidate = applyProtectedResidualRescue(selected, alphaMap, finalResidualOptions(options));
  const finalVisualResidual = finalCandidate.protectedResidualRescue || null;
  const finalAccepted = Boolean(finalVisualResidual?.accepted);
  if (finalAccepted) {
    selected = {
      width: finalCandidate.width,
      height: finalCandidate.height,
      data: new Uint8ClampedArray(finalCandidate.data)
    };
  }

  const escalated = applyOutlineResidualEscalation(selected, alphaMap, outlineEscalationOptions(options));
  const outlineResidualEscalation = escalated.outlineResidualEscalation || null;
  const outlineEscalationAccepted = Boolean(outlineResidualEscalation?.accepted);
  if (outlineEscalationAccepted) {
    selected = {
      width: escalated.width,
      height: escalated.height,
      data: new Uint8ClampedArray(escalated.data)
    };
  }

  const microCandidate = applyContourMicroInterpolation(selected, alphaMap, microInterpolationOptions(options));
  const contourMicroInterpolation = microCandidate.contourMicroInterpolation || null;
  const contourMicroInterpolationAccepted = Boolean(contourMicroInterpolation?.accepted);
  if (contourMicroInterpolationAccepted) {
    selected = {
      width: microCandidate.width,
      height: microCandidate.height,
      data: new Uint8ClampedArray(microCandidate.data)
    };
  }

  const accepted = structuredAccepted || finalAccepted || outlineEscalationAccepted || contourMicroInterpolationAccepted;
  let acceptedMode = 'none';
  if (outlineEscalationAccepted) {
    if (structuredAccepted && finalAccepted) acceptedMode = 'structured-smooth+final-visual+outline-escalation';
    else if (finalAccepted) acceptedMode = 'final-visual+outline-escalation';
    else if (structuredAccepted) acceptedMode = 'structured-smooth+outline-escalation';
    else acceptedMode = 'outline-residual-escalation';
  } else if (finalAccepted) {
    acceptedMode = structuredAccepted ? 'structured-smooth+final-visual' : 'final-visual-residual-rescue';
  } else if (structuredAccepted) {
    acceptedMode = 'structured-smooth-rescue';
  }
  if (contourMicroInterpolationAccepted) {
    acceptedMode = acceptedMode === 'none'
      ? 'contour-micro-interpolation'
      : `${acceptedMode}+contour-micro-interpolation`;
  }

  const finalGlobal = measurePostCleanupResidual(selected, alphaMap);
  const finalAligned = measureStructuredRingResidual(selected, alphaMap);
  const postChainOutlineResidual = measurePostChainOutlineResidual(selected, alphaMap, options);
  const postChainOutlineSceneSafe = outlineResidualEscalation?.sceneEligible !== false;

  return {
    width: selected.width,
    height: selected.height,
    data: selected.data,
    structuredSmoothRescue: {
      enabled: options.enabled !== false,
      attempted: structuredAttempted
        || Boolean(finalVisualResidual?.attempted)
        || Boolean(outlineResidualEscalation?.attempted)
        || Boolean(contourMicroInterpolation?.attempted),
      accepted,
      acceptedMode,
      structuredAttempted,
      structuredMetricsAccepted,
      structuredAccepted,
      finalVisualAccepted: finalAccepted,
      outlineEscalationAccepted,
      contourMicroInterpolationAccepted,
      ...gate,
      beforeGlobal,
      afterGlobal: finalGlobal,
      candidateAfterGlobal: structuredCandidateGlobal,
      beforeAligned,
      afterAligned: finalAligned,
      candidateAfterAligned: structuredCandidateAligned,
      improvement: ratioImprovement(beforeGlobal.total, finalGlobal.total),
      candidateImprovement: improvement,
      alignedImprovement: ratioImprovement(beforeAligned.score, finalAligned.score),
      candidateAlignedImprovement: alignedImprovement,
      maxChromaIncrease,
      smoothBackground: candidateSmoothBackground,
      artifactGuard,
      finalVisualResidual,
      outlineResidualEscalation,
      contourMicroInterpolation,
      postChainOutlineResidual,
      postChainOutlineSceneSafe
    }
  };
}

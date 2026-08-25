import { applySmoothBackgroundReconstruction } from './smoothBackground.js';
import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureStructuredRingResidual } from './structuredRingSuppress.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';
import { applyProtectedResidualRescue } from './protectedResidualRescue.js';

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
    minScore: finite(options.finalResidualMinScore, 0.90),
    minDensity: finite(options.finalResidualMinDensity, 0.07),
    minSamples: Math.max(8, Math.round(finite(options.finalResidualMinSamples, 10))),
    minImprovement: finite(options.finalResidualMinImprovement, 0.012),
    strength: finite(options.finalResidualStrength, 0.50),
    maxBlend: finite(options.finalResidualMaxBlend, 0.40),
    maxLumaDelta: finite(options.finalResidualMaxLumaDelta, 12),
    hardSceneGuard: finite(options.finalResidualHardSceneGuard, 0.58),
    ...(options.finalResidualOptions || {})
  };
}

export function applyStructuredSmoothRescue(image, alphaMap, smoothAnalysis = {}, structuredRing = {}, options = {}) {
  const gate = evaluateStructuredSmoothRescueEligibility(image, alphaMap, smoothAnalysis, structuredRing, options);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const beforeAligned = gate.aligned;
  let structuredAttempted = false;
  let structuredAccepted = false;
  let selected = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  let structuredCandidateGlobal = beforeGlobal;
  let structuredCandidateAligned = beforeAligned;
  let improvement = 0;
  let alignedImprovement = 0;
  let candidateSmoothBackground = null;
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

    structuredAccepted = detailAccepted
      && alignedImprovement >= finite(options.minAlignedImprovement, 0.12)
      && structuredCandidateAligned.score <= beforeAligned.score * finite(options.maxAlignedRatio, 0.88)
      && structuredCandidateGlobal.total <= beforeGlobal.total * finite(options.maxTotalRatio, 0.992) + 0.02
      && structuredCandidateGlobal.luma <= beforeGlobal.luma * finite(options.maxLumaRatio, 0.995) + 0.03
      && structuredCandidateGlobal.chroma <= beforeGlobal.chroma * finite(options.maxChromaRatio, 1.01) + maxChromaIncrease;

    if (structuredAccepted) selected = candidateImage;
  }

  // Always run a final visual-shape verifier. This is intentionally independent of
  // the structured-ring accept state so a visually obvious residual cannot hide
  // behind a successful earlier pass or an empty diagnostics flag set.
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

  const accepted = structuredAccepted || finalAccepted;
  const acceptedMode = finalAccepted
    ? (structuredAccepted ? 'structured-smooth+final-visual' : 'final-visual-residual-rescue')
    : (structuredAccepted ? 'structured-smooth-rescue' : 'none');
  const finalGlobal = measurePostCleanupResidual(selected, alphaMap);
  const finalAligned = measureStructuredRingResidual(selected, alphaMap);

  return {
    width: selected.width,
    height: selected.height,
    data: selected.data,
    structuredSmoothRescue: {
      enabled: options.enabled !== false,
      attempted: structuredAttempted || Boolean(finalVisualResidual?.attempted),
      accepted,
      acceptedMode,
      structuredAttempted,
      structuredAccepted,
      finalVisualAccepted: finalAccepted,
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
      finalVisualResidual
    }
  };
}

import { applySmoothBackgroundReconstruction } from './smoothBackground.js';
import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureStructuredRingResidual } from './structuredRingSuppress.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';

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

  // Judge smoothness mostly from the clean exterior. A watermark-shaped residual can
  // itself inflate coreStructureDensity, so that metric must not permanently force a
  // genuinely flat background into the structured branch.
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

export function applyStructuredSmoothRescue(image, alphaMap, smoothAnalysis = {}, structuredRing = {}, options = {}) {
  const gate = evaluateStructuredSmoothRescueEligibility(image, alphaMap, smoothAnalysis, structuredRing, options);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const beforeAligned = gate.aligned;
  if (!gate.eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      structuredSmoothRescue: {
        enabled: options.enabled !== false,
        attempted: false,
        accepted: false,
        ...gate,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        beforeAligned,
        afterAligned: beforeAligned,
        improvement: 0,
        alignedImprovement: 0
      }
    };
  }

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
  const afterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const afterAligned = measureStructuredRingResidual(candidateImage, alphaMap);
  const improvement = ratioImprovement(beforeGlobal.total, afterGlobal.total);
  const alignedImprovement = ratioImprovement(beforeAligned.score, afterAligned.score);
  const detailAccepted = candidate.smoothBackground?.accepted !== false
    && candidate.smoothBackground?.detailPreservation?.accepted !== false;
  const maxChromaIncrease = finite(options.maxChromaIncrease, 0.75);

  // Smooth reconstruction can introduce a very small chroma residual when the
  // incoming ROI is nearly chroma-perfect. A pure ratio gate is unstable near zero,
  // so keep the ratio check but add a tight absolute allowance. Global total/luma
  // still must improve materially, which prevents accepting a color-shifted result.
  const accepted = detailAccepted
    && alignedImprovement >= finite(options.minAlignedImprovement, 0.12)
    && afterAligned.score <= beforeAligned.score * finite(options.maxAlignedRatio, 0.88)
    && afterGlobal.total <= beforeGlobal.total * finite(options.maxTotalRatio, 0.992) + 0.02
    && afterGlobal.luma <= beforeGlobal.luma * finite(options.maxLumaRatio, 0.995) + 0.03
    && afterGlobal.chroma <= beforeGlobal.chroma * finite(options.maxChromaRatio, 1.01) + maxChromaIncrease;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? new Uint8ClampedArray(candidate.data) : new Uint8ClampedArray(image.data),
    structuredSmoothRescue: {
      enabled: true,
      attempted: true,
      accepted,
      ...gate,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal,
      beforeAligned,
      afterAligned: accepted ? afterAligned : beforeAligned,
      candidateAfterAligned: afterAligned,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      alignedImprovement: accepted ? alignedImprovement : 0,
      candidateAlignedImprovement: alignedImprovement,
      maxChromaIncrease,
      smoothBackground: candidate.smoothBackground || null
    }
  };
}

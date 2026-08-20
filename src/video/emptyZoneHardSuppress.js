import { applySmoothBackgroundReconstruction, evaluateSmoothDetailPreservation } from './smoothBackground.js';
import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function classifyNearEmptyBackground(analysis, options = {}) {
  const limits = {
    maxComplexity: Number.isFinite(options.maxComplexity) ? options.maxComplexity : 0.16,
    maxSurfaceMae: Number.isFinite(options.maxSurfaceMae) ? options.maxSurfaceMae : 3.8,
    maxEdgeDensity: Number.isFinite(options.maxEdgeDensity) ? options.maxEdgeDensity : 0.012,
    maxMeanGradient: Number.isFinite(options.maxMeanGradient) ? options.maxMeanGradient : 3.2,
    maxMeanLaplacian: Number.isFinite(options.maxMeanLaplacian) ? options.maxMeanLaplacian : 3.2,
    maxCoreStructureDensity: Number.isFinite(options.maxCoreStructureDensity) ? options.maxCoreStructureDensity : 0.06
  };
  if (!analysis?.safe || !analysis?.coefficients) {
    return { eligible: false, reason: 'not-smooth-safe', limits };
  }
  const failures = [];
  if (analysis.complexity > limits.maxComplexity) failures.push('complexity');
  if (analysis.surfaceMae > limits.maxSurfaceMae) failures.push('surface-fit');
  if (analysis.edgeDensity > limits.maxEdgeDensity) failures.push('edge-density');
  if (Number.isFinite(analysis.meanGradient) && analysis.meanGradient > limits.maxMeanGradient) failures.push('gradient-energy');
  if (Number.isFinite(analysis.meanLaplacian) && analysis.meanLaplacian > limits.maxMeanLaplacian) failures.push('high-frequency-energy');
  if (Number.isFinite(analysis.coreStructureDensity) && analysis.coreStructureDensity > limits.maxCoreStructureDensity) failures.push('core-structure');
  return {
    eligible: failures.length === 0,
    reason: failures.length ? failures.join(',') : 'near-empty-background',
    limits
  };
}

function preservationGuardTriggered(result) {
  const detail = result?.smoothBackground?.detailPreservation;
  return Boolean(detail?.guardTriggered || detail?.fallbackAttempted || result?.smoothBackground?.accepted === false);
}

export function applySafeEmptyZoneHardSuppression(image, alphaMap, analysis, options = {}) {
  const classification = classifyNearEmptyBackground(analysis, options);
  const before = measurePostCleanupResidual(image, alphaMap);
  const crossingEdge = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});
  if (options.enabled === false || !classification.eligible || crossingEdge.protect) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      emptyZoneHard: {
        enabled: options.enabled !== false,
        eligible: classification.eligible && !crossingEdge.protect,
        attempted: false,
        accepted: false,
        reason: crossingEdge.protect ? 'crossing-scene-edge-protection' : classification.reason,
        before,
        after: before,
        candidateAfter: before,
        improvement: 0,
        limits: classification.limits,
        crossingEdge
      }
    };
  }

  const first = applySmoothBackgroundReconstruction(image, alphaMap, { ...analysis, safe: true }, {
    strength: 1,
    dilationRadius: options.dilationRadius ?? 5,
    microSmooth: options.microSmooth ?? 0.22
  });
  if (preservationGuardTriggered(first)) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      emptyZoneHard: {
        enabled: true,
        eligible: true,
        attempted: true,
        accepted: false,
        reason: 'detail-preservation-guard',
        before,
        after: before,
        candidateAfter: before,
        improvement: 0,
        limits: classification.limits,
        crossingEdge,
        detailPreservation: first.smoothBackground?.detailPreservation || null
      }
    };
  }
  const firstImage = { width: first.width, height: first.height, data: first.data };
  const second = applySmoothBackgroundReconstruction(firstImage, alphaMap, { ...analysis, safe: true }, {
    strength: options.secondStrength ?? 0.82,
    dilationRadius: options.secondDilationRadius ?? 5,
    microSmooth: options.secondMicroSmooth ?? 0.20
  });
  if (preservationGuardTriggered(second)) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      emptyZoneHard: {
        enabled: true,
        eligible: true,
        attempted: true,
        accepted: false,
        reason: 'detail-preservation-guard',
        before,
        after: before,
        candidateAfter: before,
        improvement: 0,
        limits: classification.limits,
        crossingEdge,
        detailPreservation: second.smoothBackground?.detailPreservation || null
      }
    };
  }
  const candidate = { width: second.width, height: second.height, data: second.data };
  const finalDetail = evaluateSmoothDetailPreservation(image, candidate, alphaMap, {
    minGradientRetention: options.minGradientRetention ?? 0.82,
    minLaplacianRetention: options.minLaplacianRetention ?? 0.78,
    minEdgeRetention: options.minEdgeRetention ?? 0.74,
    minGradientEvidence: options.minGradientEvidence ?? 1.5,
    minLaplacianEvidence: options.minLaplacianEvidence ?? 2.0,
    minEdgeEvidence: options.minEdgeEvidence ?? 0.02,
    minWeight: options.minDetailWeight ?? 5.0
  });
  const candidateAfter = measurePostCleanupResidual(candidate, alphaMap);
  const improvement = before.total > 1e-6 ? (before.total - candidateAfter.total) / before.total : 0;
  const accepted = finalDetail.accepted
    && candidateAfter.total <= before.total * 0.994
    && candidateAfter.luma <= before.luma * 1.012
    && candidateAfter.chroma <= before.chroma * 1.045;
  const selected = accepted ? candidate : image;
  return {
    width: selected.width,
    height: selected.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    emptyZoneHard: {
      enabled: true,
      eligible: true,
      attempted: true,
      accepted,
      reason: accepted ? classification.reason : (finalDetail.accepted ? 'residual-safety-reject' : 'final-detail-preservation-reject'),
      before,
      after: accepted ? candidateAfter : before,
      candidateAfter,
      improvement: accepted ? clamp(improvement, -1, 1) : 0,
      candidateImprovement: improvement,
      limits: classification.limits,
      crossingEdge,
      finalDetail
    }
  };
}

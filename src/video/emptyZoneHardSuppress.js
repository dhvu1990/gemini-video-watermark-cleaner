import { applySmoothBackgroundReconstruction } from './smoothBackground.js';
import { measurePostCleanupResidual } from './edgeBridge.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function classifyNearEmptyBackground(analysis, options = {}) {
  const limits = {
    maxComplexity: Number.isFinite(options.maxComplexity) ? options.maxComplexity : 0.22,
    maxSurfaceMae: Number.isFinite(options.maxSurfaceMae) ? options.maxSurfaceMae : 5.5,
    maxEdgeDensity: Number.isFinite(options.maxEdgeDensity) ? options.maxEdgeDensity : 0.025,
    maxMeanGradient: Number.isFinite(options.maxMeanGradient) ? options.maxMeanGradient : 6.5,
    maxMeanLaplacian: Number.isFinite(options.maxMeanLaplacian) ? options.maxMeanLaplacian : 5.0,
    maxCoreStructureDensity: Number.isFinite(options.maxCoreStructureDensity) ? options.maxCoreStructureDensity : 0.10
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

export function applySafeEmptyZoneHardSuppression(image, alphaMap, analysis, options = {}) {
  const classification = classifyNearEmptyBackground(analysis, options);
  const before = measurePostCleanupResidual(image, alphaMap);
  if (options.enabled === false || !classification.eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      emptyZoneHard: {
        enabled: options.enabled !== false,
        eligible: classification.eligible,
        attempted: false,
        accepted: false,
        reason: classification.reason,
        before,
        after: before,
        candidateAfter: before,
        improvement: 0,
        limits: classification.limits
      }
    };
  }

  const first = applySmoothBackgroundReconstruction(image, alphaMap, { ...analysis, safe: true }, {
    strength: 1,
    dilationRadius: options.dilationRadius ?? 6,
    microSmooth: options.microSmooth ?? 0.28
  });
  const firstImage = { width: first.width, height: first.height, data: first.data };
  const second = applySmoothBackgroundReconstruction(firstImage, alphaMap, { ...analysis, safe: true }, {
    strength: 1,
    dilationRadius: options.secondDilationRadius ?? 7,
    microSmooth: options.secondMicroSmooth ?? 0.30
  });
  const candidate = { width: second.width, height: second.height, data: second.data };
  const candidateAfter = measurePostCleanupResidual(candidate, alphaMap);
  const improvement = before.total > 1e-6 ? (before.total - candidateAfter.total) / before.total : 0;
  const accepted = candidateAfter.total <= before.total * 0.995
    && candidateAfter.luma <= before.luma * 1.02
    && candidateAfter.chroma <= before.chroma * 1.08;
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
      reason: classification.reason,
      before,
      after: accepted ? candidateAfter : before,
      candidateAfter,
      improvement: accepted ? clamp(improvement, -1, 1) : 0,
      limits: classification.limits
    }
  };
}

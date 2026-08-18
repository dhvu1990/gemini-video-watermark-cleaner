import { measurePostCleanupResidual } from './edgeBridge.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeRatio(after, before) {
  if (!Number.isFinite(before) || before <= 1e-9) return Number.isFinite(after) && after <= 1e-9 ? 1 : Number.POSITIVE_INFINITY;
  return after / before;
}

export function evaluateTemporalDonorAcceptance(baseline, candidate, alphaMap, options = {}) {
  const enabled = options.enabled !== false;
  const attempted = Boolean(candidate?.temporalShift || candidate?.temporalDonor);
  const diagnostics = {
    enabled,
    attempted,
    accepted: false,
    reason: !enabled ? 'disabled' : (!attempted ? 'no-temporal-candidate' : 'pending'),
    before: null,
    candidateAfter: null,
    totalRatio: 1,
    lumaRatio: 1,
    chromaRatio: 1,
    maxTotalRatio: Number.isFinite(options.maxTotalRatio) ? clamp(options.maxTotalRatio, 0.95, 1.10) : 1.002,
    maxLumaRatio: Number.isFinite(options.maxLumaRatio) ? clamp(options.maxLumaRatio, 0.95, 1.12) : 1.006,
    maxChromaRatio: Number.isFinite(options.maxChromaRatio) ? clamp(options.maxChromaRatio, 0.95, 1.12) : 1.006,
    minimumImprovement: Number.isFinite(options.minimumImprovement) ? clamp(options.minimumImprovement, -0.05, 0.10) : -0.002
  };

  if (!enabled || !attempted || !baseline || !candidate || alphaMap?.length !== baseline.width * baseline.height) {
    return { image: baseline, diagnostics };
  }

  const before = measurePostCleanupResidual(baseline, alphaMap);
  const candidateAfter = measurePostCleanupResidual(candidate, alphaMap);
  const totalRatio = safeRatio(candidateAfter.total, before.total);
  const lumaRatio = safeRatio(candidateAfter.luma, before.luma);
  const chromaRatio = safeRatio(candidateAfter.chroma, before.chroma);
  const improvement = before.total > 1e-9 ? (before.total - candidateAfter.total) / before.total : 0;
  const hasMeasuredSupport = before.samples > 0 && candidateAfter.samples > 0;
  const accepted = hasMeasuredSupport
    && totalRatio <= diagnostics.maxTotalRatio
    && lumaRatio <= diagnostics.maxLumaRatio
    && chromaRatio <= diagnostics.maxChromaRatio
    && improvement >= diagnostics.minimumImprovement;

  Object.assign(diagnostics, {
    accepted,
    reason: accepted ? 'accepted' : (hasMeasuredSupport ? 'residual-safety-gate' : 'insufficient-residual-samples'),
    before,
    candidateAfter,
    totalRatio,
    lumaRatio,
    chromaRatio,
    improvement
  });

  return { image: accepted ? candidate : baseline, diagnostics };
}

import {
  applyStructuredSmoothRescue as applyStructuredSmoothRescueCore,
  evaluateStructuredSmoothRescueEligibility as evaluateStructuredSmoothRescueEligibilityCore
} from './structuredSmoothRescueCore.js';
import { applyPostCleanQualityGate } from './postCleanQualityGate.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function diagnosticConfidence(options = {}) {
  const raw = Number(options.detectionConfidence);
  return Number.isFinite(raw) ? clamp(raw, 0, 1) : null;
}

function qualityDrivenCoreOptions(options = {}) {
  const next = { ...options };
  delete next.detectionConfidence;
  return next;
}

export function evaluateStructuredSmoothRescueEligibility(image, alphaMap, smoothAnalysis = {}, structuredRing = {}, options = {}) {
  const result = evaluateStructuredSmoothRescueEligibilityCore(
    image,
    alphaMap,
    smoothAnalysis,
    structuredRing,
    qualityDrivenCoreOptions(options)
  );
  return {
    ...result,
    inputDetectionConfidence: diagnosticConfidence(options),
    confidenceDecisionPolicy: 'quality-driven'
  };
}

function effectiveQualityScore(diag) {
  if (!diag) return Infinity;
  if (diag.accepted && Number.isFinite(diag.candidate?.score)) return diag.candidate.score;
  if (Number.isFinite(diag.before?.score)) return diag.before.score;
  return Infinity;
}

function qualityGateOptions(options = {}) {
  const confidence = diagnosticConfidence(options);
  const custom = options.postCleanQualityGateOptions || {};
  const defaults = {
    strength: 0.78,
    exteriorStrength: 0.46,
    regrainStrength: 0.30,
    maxChannelDelta: 36,
    minQualityImprovement: 0.08,
    maxSceneEdgeScore: 0.30
  };

  return {
    enabled: options.postCleanQualityGateEnabled !== false,
    supportAlpha: finite(options.postCleanQualityGateSupportAlpha, 0.006),
    donorInnerRadius: finite(options.postCleanQualityGateDonorInnerRadius, 4),
    donorOuterRadius: finite(options.postCleanQualityGateDonorOuterRadius, 12),
    haloRadius: finite(options.postCleanQualityGateHaloRadius, 3),
    maxDonorAlpha: finite(options.postCleanQualityGateMaxDonorAlpha, 0.004),
    minDonorSamples: finite(options.postCleanQualityGateMinDonorSamples, 48),
    minSupportPixels: finite(options.postCleanQualityGateMinSupportPixels, 18),
    maxModelMae: finite(options.postCleanQualityGateMaxModelMae, 7.8),
    maxRgbMae: finite(options.postCleanQualityGateMaxRgbMae, 9.8),
    maxMeanGradient: finite(options.postCleanQualityGateMaxMeanGradient, 9.5),
    maxHighGradientDensity: finite(options.postCleanQualityGateMaxHighGradientDensity, 0.09),
    minBeforeScore: finite(options.postCleanQualityGateMinBeforeScore, 4.8),
    minModelMismatch: finite(options.postCleanQualityGateMinModelMismatch, 3.6),
    minBoundaryMismatch: finite(options.postCleanQualityGateMinBoundaryMismatch, 3.2),
    minCorrectedPixels: finite(options.postCleanQualityGateMinCorrectedPixels, 10),
    maxModelMismatchRatio: finite(options.postCleanQualityGateMaxModelMismatchRatio, 0.96),
    maxBoundaryMismatchRatio: finite(options.postCleanQualityGateMaxBoundaryMismatchRatio, 0.98),
    maxContourResidualRatio: finite(options.postCleanQualityGateMaxContourResidualRatio, 1.04),
    sceneEdgeOptions: options.sceneEdgeOptions || {},
    ...defaults,
    ...custom,
    enabled: options.postCleanQualityGateEnabled !== false && custom.enabled !== false,
    detectionConfidence: confidence
  };
}

export function applyStructuredSmoothRescue(image, alphaMap, smoothAnalysis = {}, structuredRing = {}, options = {}) {
  const coreResult = applyStructuredSmoothRescueCore(
    image,
    alphaMap,
    smoothAnalysis,
    structuredRing,
    qualityDrivenCoreOptions(options)
  );
  const coreDiagnostics = coreResult.structuredSmoothRescue || {};
  const gateOptions = qualityGateOptions(options);

  if (gateOptions.enabled === false) {
    return {
      ...coreResult,
      structuredSmoothRescue: {
        ...coreDiagnostics,
        inputDetectionConfidence: gateOptions.detectionConfidence,
        confidenceDecisionPolicy: 'quality-driven',
        postCleanQualityGate: {
          attempted: false,
          accepted: false,
          reason: 'disabled',
          selectedCandidate: 'core'
        }
      }
    };
  }

  const coreImage = {
    width: coreResult.width,
    height: coreResult.height,
    data: new Uint8ClampedArray(coreResult.data)
  };
  const inputImage = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };

  const gatedCore = applyPostCleanQualityGate(coreImage, alphaMap, gateOptions);
  const gatedInput = applyPostCleanQualityGate(inputImage, alphaMap, gateOptions);
  const coreGate = gatedCore.postCleanQualityGate || null;
  const inputGate = gatedInput.postCleanQualityGate || null;

  const coreScore = effectiveQualityScore(coreGate);
  const inputScore = effectiveQualityScore(inputGate);
  const coreArtifactStrong = finite(coreGate?.before?.score, 0) >= finite(options.postCleanQualityGateRollbackScore, 6.0);
  const rollbackRatio = finite(options.postCleanQualityGateRollbackRatio, 0.94);
  const inputClearlyBetter = Number.isFinite(coreScore)
    && Number.isFinite(inputScore)
    && coreArtifactStrong
    && inputScore <= coreScore * rollbackRatio;

  let selected = gatedCore;
  let selectedBranch = 'core';
  let rollbackToInput = false;

  if (inputClearlyBetter) {
    selected = gatedInput;
    selectedBranch = 'input';
    rollbackToInput = true;
  }

  const selectedGate = selectedBranch === 'core' ? coreGate : inputGate;
  const qualityAccepted = Boolean(selectedGate?.accepted);
  const coreAccepted = Boolean(coreDiagnostics.accepted);
  const accepted = selectedBranch === 'core'
    ? (coreAccepted || qualityAccepted)
    : qualityAccepted;

  let acceptedMode = coreDiagnostics.acceptedMode || 'none';
  if (selectedBranch === 'core' && qualityAccepted) {
    acceptedMode = acceptedMode === 'none'
      ? 'post-clean-quality-gate'
      : `${acceptedMode}+post-clean-quality-gate`;
  } else if (selectedBranch === 'input' && qualityAccepted) {
    acceptedMode = 'post-clean-quality-gate-from-input';
  } else if (rollbackToInput) {
    acceptedMode = 'none';
  }

  const data = accepted
    ? new Uint8ClampedArray(selected.data)
    : new Uint8ClampedArray(image.data);

  return {
    width: image.width,
    height: image.height,
    data,
    structuredSmoothRescue: {
      ...coreDiagnostics,
      attempted: Boolean(coreDiagnostics.attempted || coreGate?.attempted || inputGate?.attempted),
      accepted,
      acceptedMode,
      inputDetectionConfidence: gateOptions.detectionConfidence,
      confidenceDecisionPolicy: 'quality-driven',
      postCleanQualityGateAccepted: qualityAccepted,
      postCleanQualityGate: {
        attempted: Boolean(coreGate?.attempted || inputGate?.attempted),
        accepted: qualityAccepted,
        selectedCandidate: selectedBranch,
        rollbackToInput,
        coreScore,
        inputScore,
        rollbackRatio,
        core: coreGate,
        input: inputGate
      }
    }
  };
}

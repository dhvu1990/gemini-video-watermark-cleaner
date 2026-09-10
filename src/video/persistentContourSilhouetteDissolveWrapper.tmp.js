import { applyPersistentContourSilhouetteDissolve as applyPersistentContourCore } from './persistentContourSilhouetteDissolveCore.js';
import { applyHighConfidenceBodyResidualRescue } from './highConfidenceBodyResidualRescue.js';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function strongOutline(outline = {}, options = {}) {
  const minScore = finite(options.minScore, 0.88);
  const minDensity = finite(options.minDensity, 0.040);
  const minSamples = Math.max(6, Math.round(finite(options.minSamples, 8)));
  const minSectors = Math.max(2, Math.round(finite(options.minSectors, 2)));
  return finite(outline.score, 0) >= minScore
    && finite(outline.candidateDensity, 0) >= minDensity
    && finite(outline.samples, 0) >= minSamples
    && finite(outline.sectorSupport, 0) >= minSectors;
}

function cloneImage(image) {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
}

export function applyPersistentContourSilhouetteDissolve(image, alphaMap, options = {}) {
  const core = applyPersistentContourCore(image, alphaMap, options);
  const coreDiagnostics = core.persistentContourSilhouetteDissolve || null;
  if (!coreDiagnostics) return core;

  const selected = cloneImage(core);
  const preBodyRemainingStrong = coreDiagnostics.remainingStrong === true;
  const detectionConfidence = finite(
    coreDiagnostics.confidencePolicy?.confidence,
    finite(options.detectionConfidence, 0)
  );

  const bodyResult = applyHighConfidenceBodyResidualRescue(
    selected,
    alphaMap,
    {
      enabled: options.highConfidenceBodyResidualRescue !== false,
      trigger: preBodyRemainingStrong,
      detectionConfidence,
      sceneEdgeOptions: options.sceneEdgeOptions || {},
      ...(options.highConfidenceBodyResidualOptions || {})
    }
  );
  const bodyResidualRescue = bodyResult.highConfidenceBodyResidualRescue || null;
  const bodyResidualAccepted = Boolean(bodyResidualRescue?.accepted);

  if (!bodyResidualAccepted) {
    return {
      width: core.width,
      height: core.height,
      data: new Uint8ClampedArray(core.data),
      persistentContourSilhouetteDissolve: {
        ...coreDiagnostics,
        preBodyRemainingStrong,
        bodyResidualAccepted: false,
        bodyResidualCorrectedPixels: 0,
        bodyResidualRescue
      }
    };
  }

  const afterOutline = bodyResidualRescue.afterOutline || coreDiagnostics.afterOutline;
  const afterGlobal = bodyResidualRescue.afterGlobal || coreDiagnostics.afterGlobal;
  const remainingStrong = strongOutline(afterOutline, options);
  const coreAccepted = Boolean(coreDiagnostics.accepted);
  const correctedPixels = finite(coreDiagnostics.correctedPixels, 0)
    + finite(bodyResidualRescue.correctedPixels, 0);
  const acceptanceMode = coreAccepted
    ? coreDiagnostics.acceptanceMode
    : 'high-confidence-body-residual';

  return {
    width: bodyResult.width,
    height: bodyResult.height,
    data: new Uint8ClampedArray(bodyResult.data),
    persistentContourSilhouetteDissolve: {
      ...coreDiagnostics,
      attempted: Boolean(coreDiagnostics.attempted || bodyResidualRescue.attempted),
      accepted: true,
      reason: coreAccepted ? coreDiagnostics.reason : 'body-residual-improvement',
      acceptanceMode,
      afterOutline,
      afterGlobal,
      outlineImprovement: finite(coreDiagnostics.beforeOutline?.score, 0) > 1e-9
        ? (finite(coreDiagnostics.beforeOutline.score, 0) - finite(afterOutline?.score, 0)) / finite(coreDiagnostics.beforeOutline.score, 1)
        : 0,
      correctedPixels,
      preBodyRemainingStrong,
      remainingStrong,
      bodyResidualAccepted: true,
      bodyResidualCorrectedPixels: finite(bodyResidualRescue.correctedPixels, 0),
      bodyResidualRescue
    }
  };
}

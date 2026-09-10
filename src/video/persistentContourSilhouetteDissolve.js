import { applyPersistentContourSilhouetteDissolve as applyPersistentContourCore } from './persistentContourSilhouetteDissolveCore.js';
import { applyHighConfidenceBodyResidualRescue } from './highConfidenceBodyResidualRescue.js';
import { applyBoundaryAwareBackgroundReconstruction } from './boundaryBackgroundReconstruction.js';

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

  let selected = cloneImage(core);
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
  if (bodyResidualAccepted) selected = cloneImage(bodyResult);

  const backgroundTrigger = options.backgroundReconstruction !== false
    && detectionConfidence >= finite(options.backgroundReconstructionMinConfidence, 0.50)
    && Boolean(
      coreDiagnostics.attempted
      || coreDiagnostics.accepted
      || coreDiagnostics.remainingStrong
      || bodyResidualAccepted
    );
  const backgroundResult = applyBoundaryAwareBackgroundReconstruction(
    selected,
    alphaMap,
    {
      enabled: backgroundTrigger,
      detectionConfidence,
      sceneEdgeOptions: options.sceneEdgeOptions || {},
      ...(options.backgroundReconstructionOptions || {})
    }
  );
  const backgroundReconstruction = backgroundResult.backgroundReconstruction || null;
  const backgroundAccepted = Boolean(backgroundReconstruction?.accepted);
  if (backgroundAccepted) selected = cloneImage(backgroundResult);

  const coreAccepted = Boolean(coreDiagnostics.accepted);
  const anyAccepted = coreAccepted || bodyResidualAccepted || backgroundAccepted;
  const afterOutline = bodyResidualAccepted
    ? (bodyResidualRescue.afterOutline || coreDiagnostics.afterOutline)
    : coreDiagnostics.afterOutline;
  const afterGlobal = backgroundAccepted
    ? (backgroundReconstruction.afterResidual || bodyResidualRescue?.afterGlobal || coreDiagnostics.afterGlobal)
    : (bodyResidualAccepted
      ? (bodyResidualRescue.afterGlobal || coreDiagnostics.afterGlobal)
      : coreDiagnostics.afterGlobal);
  const remainingStrong = strongOutline(afterOutline, options);
  const correctedPixels = finite(coreDiagnostics.correctedPixels, 0)
    + (bodyResidualAccepted ? finite(bodyResidualRescue.correctedPixels, 0) : 0)
    + (backgroundAccepted ? finite(backgroundReconstruction.correctedPixels, 0) : 0);
  const acceptanceMode = backgroundAccepted
    ? (bodyResidualAccepted ? 'body+background-reconstruction' : 'boundary-background-reconstruction')
    : (bodyResidualAccepted
      ? (coreAccepted ? coreDiagnostics.acceptanceMode : 'high-confidence-body-residual')
      : coreDiagnostics.acceptanceMode);

  return {
    width: selected.width,
    height: selected.height,
    data: new Uint8ClampedArray(selected.data),
    persistentContourSilhouetteDissolve: {
      ...coreDiagnostics,
      attempted: Boolean(
        coreDiagnostics.attempted
        || bodyResidualRescue?.attempted
        || backgroundReconstruction?.attempted
      ),
      accepted: anyAccepted,
      reason: backgroundAccepted
        ? 'background-reconstruction-improvement'
        : (bodyResidualAccepted
          ? (coreAccepted ? coreDiagnostics.reason : 'body-residual-improvement')
          : coreDiagnostics.reason),
      acceptanceMode,
      afterOutline,
      afterGlobal,
      outlineImprovement: finite(coreDiagnostics.beforeOutline?.score, 0) > 1e-9
        ? (finite(coreDiagnostics.beforeOutline.score, 0) - finite(afterOutline?.score, 0)) / finite(coreDiagnostics.beforeOutline.score, 1)
        : 0,
      correctedPixels,
      preBodyRemainingStrong,
      remainingStrong,
      bodyResidualAccepted,
      bodyResidualCorrectedPixels: bodyResidualAccepted ? finite(bodyResidualRescue.correctedPixels, 0) : 0,
      bodyResidualRescue,
      backgroundReconstructionTriggered: backgroundTrigger,
      backgroundReconstructionAccepted: backgroundAccepted,
      backgroundReconstructionCorrectedPixels: backgroundAccepted ? finite(backgroundReconstruction.correctedPixels, 0) : 0,
      backgroundReconstruction
    }
  };
}

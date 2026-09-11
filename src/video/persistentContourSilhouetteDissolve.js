import { applyPersistentContourSilhouetteDissolve as applyPersistentContourCore } from './persistentContourSilhouetteDissolveCore.js';
import { applyHighConfidenceBodyResidualRescue } from './highConfidenceBodyResidualRescue.js';
import { applyBoundaryAwareBackgroundReconstruction } from './boundaryBackgroundReconstruction.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';
import { evaluateSmoothRebuildArtifactGuard } from './smoothRebuildArtifactGuard.js';

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
  // Detection confidence answers "is this the expected watermark?". It must not
  // make restoration stronger. v1.0.130 deliberately runs every accepted
  // detection through the same conservative cleanup-confidence profile that
  // matched the safer medium-confidence real-world scenes.
  const observedDetectionConfidence = finite(options.detectionConfidence, 0);
  const cleanupConfidence = Math.max(0.40, Math.min(0.64, finite(options.cleanupConfidence, 0.55)));
  const cleanupOptions = { ...options, detectionConfidence: cleanupConfidence };

  const core = applyPersistentContourCore(image, alphaMap, cleanupOptions);
  const coreDiagnostics = core.persistentContourSilhouetteDissolve || null;
  if (!coreDiagnostics) return core;

  let selected = cloneImage(core);
  const preBodyRemainingStrong = coreDiagnostics.remainingStrong === true;

  // The v1.0.127 high-confidence body pass is now opt-in only. Fresh v1.0.129
  // validation showed that the broad body reconstruction can create a dark/brown
  // blotch on textured scenes even when localization confidence is 0.9+.
  const bodyOptIn = options.highConfidenceBodyResidualRescue === true;
  const bodyResult = applyHighConfidenceBodyResidualRescue(
    selected,
    alphaMap,
    {
      enabled: bodyOptIn,
      trigger: bodyOptIn && preBodyRemainingStrong,
      detectionConfidence: observedDetectionConfidence,
      sceneEdgeOptions: options.sceneEdgeOptions || {},
      ...(options.highConfidenceBodyResidualOptions || {})
    }
  );
  const bodyResidualRescue = bodyResult.highConfidenceBodyResidualRescue || null;
  const bodyResidualAccepted = Boolean(bodyResidualRescue?.accepted);
  if (bodyResidualAccepted) selected = cloneImage(bodyResult);

  // Background reconstruction keeps actual confidence only as a detector gate.
  // Its restoration strength receives the fixed conservative cleanup profile.
  const backgroundSceneRisk = measureCrossingSceneEdgeRisk(
    selected,
    alphaMap,
    options.backgroundReconstructionSceneEdgeOptions || {}
  );
  const backgroundSceneSafe = !backgroundSceneRisk.protect && backgroundSceneRisk.level !== 'high';
  const backgroundTrigger = options.backgroundReconstruction !== false
    && observedDetectionConfidence >= finite(options.backgroundReconstructionMinConfidence, 0.50)
    && backgroundSceneSafe
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
      detectionConfidence: cleanupConfidence,
      sceneEdgeOptions: options.sceneEdgeOptions || {},
      ...(options.backgroundReconstructionOptions || {})
    }
  );
  const backgroundReconstruction = backgroundResult.backgroundReconstruction || null;
  const backgroundAccepted = Boolean(backgroundReconstruction?.accepted);
  if (backgroundAccepted) selected = cloneImage(backgroundResult);

  const coreAccepted = Boolean(coreDiagnostics.accepted);
  const candidateAccepted = coreAccepted || bodyResidualAccepted || backgroundAccepted;

  // Physical image-quality guard for the complete late reconstruction chain.
  // Residual-score checks are intentionally disabled here: this gate only asks
  // whether the candidate introduced destructive darkening or collapsed scene
  // structure. If it did, roll the whole late chain back to its input.
  const postChainArtifactGuard = evaluateSmoothRebuildArtifactGuard(
    image,
    selected,
    alphaMap,
    {
      residualChecksEnabled: false,
      ...(options.postChainArtifactGuardOptions || {})
    }
  );
  const qualityRollback = candidateAccepted && postChainArtifactGuard.rollback;
  if (qualityRollback) selected = cloneImage(image);
  const anyAccepted = candidateAccepted && !qualityRollback;

  const candidateAfterOutline = bodyResidualAccepted
    ? (bodyResidualRescue.afterOutline || coreDiagnostics.afterOutline)
    : coreDiagnostics.afterOutline;
  const candidateAfterGlobal = backgroundAccepted
    ? (backgroundReconstruction.afterResidual || bodyResidualRescue?.afterGlobal || coreDiagnostics.afterGlobal)
    : (bodyResidualAccepted
      ? (bodyResidualRescue.afterGlobal || coreDiagnostics.afterGlobal)
      : coreDiagnostics.afterGlobal);
  const afterOutline = qualityRollback ? coreDiagnostics.beforeOutline : candidateAfterOutline;
  const afterGlobal = qualityRollback ? coreDiagnostics.beforeGlobal : candidateAfterGlobal;
  const remainingStrong = strongOutline(afterOutline, options);
  const candidateCorrectedPixels = finite(coreDiagnostics.correctedPixels, 0)
    + (bodyResidualAccepted ? finite(bodyResidualRescue.correctedPixels, 0) : 0)
    + (backgroundAccepted ? finite(backgroundReconstruction.correctedPixels, 0) : 0);
  const correctedPixels = qualityRollback ? 0 : candidateCorrectedPixels;

  // Preserve the historical acceptanceMode contract whenever the core pass
  // already accepted. New post-processing provenance is exposed separately.
  const acceptanceMode = qualityRollback
    ? 'quality-rollback'
    : (coreAccepted
      ? coreDiagnostics.acceptanceMode
      : (bodyResidualAccepted
        ? 'high-confidence-body-residual'
        : (backgroundAccepted ? 'boundary-background-reconstruction' : coreDiagnostics.acceptanceMode)));
  const postAcceptanceMode = qualityRollback
    ? 'quality-rollback'
    : (backgroundAccepted
      ? (bodyResidualAccepted ? 'body+background-reconstruction' : 'boundary-background-reconstruction')
      : (bodyResidualAccepted ? 'high-confidence-body-residual' : acceptanceMode));
  const reason = qualityRollback
    ? `quality-rollback:${postChainArtifactGuard.reason}`
    : (coreAccepted
      ? coreDiagnostics.reason
      : (backgroundAccepted
        ? 'background-reconstruction-improvement'
        : (bodyResidualAccepted ? 'body-residual-improvement' : coreDiagnostics.reason)));

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
      reason,
      acceptanceMode,
      postAcceptanceMode,
      afterOutline,
      afterGlobal,
      outlineImprovement: finite(coreDiagnostics.beforeOutline?.score, 0) > 1e-9
        ? (finite(coreDiagnostics.beforeOutline.score, 0) - finite(afterOutline?.score, 0)) / finite(coreDiagnostics.beforeOutline.score, 1)
        : 0,
      correctedPixels,
      candidateCorrectedPixels,
      observedDetectionConfidence,
      cleanupConfidence,
      cleanupConfidenceDecoupled: true,
      preBodyRemainingStrong,
      remainingStrong,
      bodyOptIn,
      bodyResidualAccepted: qualityRollback ? false : bodyResidualAccepted,
      bodyResidualCorrectedPixels: qualityRollback ? 0 : (bodyResidualAccepted ? finite(bodyResidualRescue.correctedPixels, 0) : 0),
      bodyResidualRescue,
      backgroundSceneRisk,
      backgroundSceneSafe,
      backgroundReconstructionTriggered: backgroundTrigger,
      backgroundReconstructionAccepted: qualityRollback ? false : backgroundAccepted,
      backgroundReconstructionCorrectedPixels: qualityRollback ? 0 : (backgroundAccepted ? finite(backgroundReconstruction.correctedPixels, 0) : 0),
      backgroundReconstruction,
      qualityRollback,
      postChainArtifactGuard
    }
  };
}

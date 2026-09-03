import { applyResidualStructureContinuationCore } from './residualStructureContinuationCore.js';
import { applySceneProtectedContinuationEscalation } from './sceneProtectedContinuationEscalation.js';
import { applyInteriorGhostDissolve } from './interiorGhostDissolve.js';
import { applyGuardedFaintGhostDissolve } from './guardedFaintGhostDissolve.js';
import { applyLateResidualHarmonizer } from './lateResidualHarmonizer.js';

function cloneImage(image) {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
}

function appendProfile(parts, profile) {
  if (profile && profile !== 'none') parts.push(profile);
}

export function applyResidualStructureContinuation(image, alphaMap, options = {}) {
  const core = applyResidualStructureContinuationCore(image, alphaMap, options);
  const coreDiagnostics = core.residualStructureContinuationCore || null;
  let selected = coreDiagnostics?.accepted ? cloneImage(core) : cloneImage(image);

  const sceneEscalation = applySceneProtectedContinuationEscalation(
    selected,
    alphaMap,
    {
      ...(options.sceneProtectedContinuationEscalation || {}),
      enabled: options.sceneProtectedContinuationEscalation?.enabled !== false,
      sceneEdgeOptions: options.sceneEdgeOptions || options.sceneProtectedContinuationEscalation?.sceneEdgeOptions || {}
    }
  );
  const sceneDiagnostics = sceneEscalation.sceneProtectedContinuationEscalation || null;
  if (sceneDiagnostics?.accepted) selected = cloneImage(sceneEscalation);

  const interiorGhost = applyInteriorGhostDissolve(
    selected,
    alphaMap,
    {
      ...(options.interiorGhostDissolve || {}),
      enabled: options.interiorGhostDissolve?.enabled !== false,
      sceneEdgeOptions: options.sceneEdgeOptions || options.interiorGhostDissolve?.sceneEdgeOptions || {}
    }
  );
  const interiorDiagnostics = interiorGhost.interiorGhostDissolve || null;
  if (interiorDiagnostics?.accepted) selected = cloneImage(interiorGhost);

  const guardedFaintGhost = applyGuardedFaintGhostDissolve(
    selected,
    alphaMap,
    {
      ...(options.guardedFaintGhostDissolve || {}),
      enabled: options.guardedFaintGhostDissolve?.enabled !== false,
      sceneEdgeOptions: options.sceneEdgeOptions || options.guardedFaintGhostDissolve?.sceneEdgeOptions || {}
    }
  );
  const guardedDiagnostics = guardedFaintGhost.guardedFaintGhostDissolve || null;
  if (guardedDiagnostics?.accepted) selected = cloneImage(guardedFaintGhost);

  const lateHarmonizer = applyLateResidualHarmonizer(
    selected,
    alphaMap,
    {
      ...(options.lateResidualHarmonizer || {}),
      enabled: options.lateResidualHarmonizer?.enabled !== false,
      sceneEdgeOptions: options.sceneEdgeOptions || options.lateResidualHarmonizer?.sceneEdgeOptions || {}
    }
  );
  const lateDiagnostics = lateHarmonizer.lateResidualHarmonizer || null;
  if (lateDiagnostics?.accepted) selected = cloneImage(lateHarmonizer);

  const coreAccepted = Boolean(coreDiagnostics?.accepted);
  const sceneAccepted = Boolean(sceneDiagnostics?.accepted);
  const interiorAccepted = Boolean(interiorDiagnostics?.accepted);
  const guardedAccepted = Boolean(guardedDiagnostics?.accepted);
  const lateAccepted = Boolean(lateDiagnostics?.accepted);
  const accepted = coreAccepted || sceneAccepted || interiorAccepted || guardedAccepted || lateAccepted;
  const profiles = [];
  if (coreAccepted) appendProfile(profiles, coreDiagnostics?.profile);
  if (sceneAccepted) appendProfile(profiles, sceneDiagnostics?.profile);
  if (interiorAccepted) appendProfile(profiles, interiorDiagnostics?.profile);
  if (guardedAccepted) appendProfile(profiles, guardedDiagnostics?.profile);
  if (lateAccepted) appendProfile(profiles, lateDiagnostics?.profile);

  const finalAfterOutline = lateAccepted
    ? lateDiagnostics.afterOutline
    : guardedAccepted
      ? guardedDiagnostics.afterOutline
      : interiorAccepted
        ? interiorDiagnostics.afterOutline
        : sceneAccepted
          ? sceneDiagnostics.afterOutline
          : coreDiagnostics?.afterOutline;
  const finalAfterGlobal = lateAccepted
    ? lateDiagnostics.afterGlobal
    : guardedAccepted
      ? guardedDiagnostics.afterGlobal
      : interiorAccepted
        ? interiorDiagnostics.afterGlobal
        : sceneAccepted
          ? sceneDiagnostics.afterGlobal
          : coreDiagnostics?.afterGlobal;

  return {
    width: selected.width,
    height: selected.height,
    data: selected.data,
    residualStructureContinuation: {
      eligible: Boolean(
        coreDiagnostics?.eligible
        || sceneDiagnostics?.eligible
        || interiorDiagnostics?.eligible
        || guardedDiagnostics?.eligible
        || lateDiagnostics?.eligible
      ),
      attempted: Boolean(
        coreDiagnostics?.attempted
        || sceneDiagnostics?.attempted
        || interiorDiagnostics?.attempted
        || guardedDiagnostics?.attempted
        || lateDiagnostics?.attempted
      ),
      accepted,
      profile: profiles.length ? profiles.join('+') : 'none',
      beforeOutline: coreDiagnostics?.beforeOutline
        || sceneDiagnostics?.beforeOutline
        || interiorDiagnostics?.beforeOutline
        || guardedDiagnostics?.beforeOutline
        || lateDiagnostics?.beforeOutline
        || null,
      afterOutline: finalAfterOutline || coreDiagnostics?.afterOutline || null,
      candidateAfterOutline: lateDiagnostics?.afterOutline
        || guardedDiagnostics?.candidateAfterOutline
        || interiorDiagnostics?.candidateAfterOutline
        || sceneDiagnostics?.candidateAfterOutline
        || coreDiagnostics?.candidateAfterOutline
        || null,
      beforeGlobal: coreDiagnostics?.beforeGlobal
        || sceneDiagnostics?.beforeGlobal
        || interiorDiagnostics?.beforeGlobal
        || guardedDiagnostics?.beforeGlobal
        || lateDiagnostics?.beforeGlobal
        || null,
      afterGlobal: finalAfterGlobal || coreDiagnostics?.afterGlobal || null,
      candidateAfterGlobal: lateDiagnostics?.afterGlobal
        || guardedDiagnostics?.candidateAfterGlobal
        || interiorDiagnostics?.candidateAfterGlobal
        || sceneDiagnostics?.candidateAfterGlobal
        || coreDiagnostics?.candidateAfterGlobal
        || null,
      correctedPixels: (coreAccepted ? coreDiagnostics.correctedPixels || 0 : 0)
        + (sceneAccepted ? sceneDiagnostics.correctedPixels || 0 : 0)
        + (interiorAccepted ? interiorDiagnostics.correctedPixels || 0 : 0)
        + (guardedAccepted ? guardedDiagnostics.correctedPixels || 0 : 0)
        + (lateAccepted ? lateDiagnostics.correctedPixels || 0 : 0),
      candidateCorrectedPixels: (coreDiagnostics?.candidateCorrectedPixels || 0)
        + (sceneDiagnostics?.candidateCorrectedPixels || 0)
        + (interiorDiagnostics?.candidateCorrectedPixels || 0)
        + (guardedDiagnostics?.candidateCorrectedPixels || 0)
        + (lateDiagnostics?.candidateCorrectedPixels || 0),
      contourCandidates: coreDiagnostics?.contourCandidates || 0,
      pairedCandidates: coreDiagnostics?.pairedCandidates || 0,
      sceneGuardedPixels: (coreDiagnostics?.sceneGuardedPixels || 0)
        + (sceneDiagnostics?.sceneGuardedPixels || 0)
        + (interiorDiagnostics?.sceneGuardedPixels || 0)
        + (guardedDiagnostics?.sceneGuardedPixels || 0)
        + (lateDiagnostics?.sceneGuardedPixels || 0),
      continuationOverridePixels: (coreDiagnostics?.continuationOverridePixels || 0)
        + (sceneDiagnostics?.sceneOverridePixels || 0)
        + (guardedDiagnostics?.guardedOverridePixels || 0),
      faintGhostCorrectedPixels: guardedAccepted ? guardedDiagnostics.faintCorrectedPixels || 0 : 0,
      guardedFaintGhostOverridePixels: guardedAccepted ? guardedDiagnostics.guardedOverridePixels || 0 : 0,
      axisSeamCorrectedPixels: lateAccepted ? lateDiagnostics.axisSeam?.correctedPixels || 0 : 0,
      toneRematchCorrectedPixels: lateAccepted ? lateDiagnostics.planeTone?.correctedPixels || 0 : 0,
      brightFlatToneRematchAccepted: Boolean(lateDiagnostics?.planeTone?.accepted && lateDiagnostics?.referenceStats?.brightSmooth),
      curvedPixels: (coreDiagnostics?.curvedPixels || 0) + (sceneDiagnostics?.curvedTexturePixels || 0),
      artifactVetoPixels: (coreDiagnostics?.artifactVetoPixels || 0)
        + (sceneDiagnostics?.artifactVetoPixels || 0)
        + (interiorDiagnostics?.artifactVetoPixels || 0)
        + (guardedDiagnostics?.artifactVetoPixels || 0),
      strongStructureVetoPixels: guardedDiagnostics?.strongStructureVetoPixels || 0,
      meanBlend: lateAccepted
        ? (lateDiagnostics.planeTone?.accepted
            ? lateDiagnostics.planeTone.meanBlend || 0
            : lateDiagnostics.axisSeam?.meanBlend || 0)
        : guardedAccepted
          ? guardedDiagnostics.meanBlend
          : interiorAccepted
            ? interiorDiagnostics.meanBlend
            : sceneAccepted
              ? sceneDiagnostics.meanBlend
              : coreDiagnostics?.meanBlend || 0,
      candidateMeanBlend: Math.max(
        coreDiagnostics?.candidateMeanBlend || 0,
        sceneDiagnostics?.candidateMeanBlend || 0,
        interiorDiagnostics?.candidateMeanBlend || 0,
        guardedDiagnostics?.candidateMeanBlend || 0,
        lateDiagnostics?.axisSeam?.candidateMeanBlend || 0,
        lateDiagnostics?.planeTone?.candidateMeanBlend || 0
      ),
      meanPairAgreement: guardedAccepted
        ? guardedDiagnostics.meanAgreement
        : sceneAccepted
          ? sceneDiagnostics.meanPairAgreement
          : coreDiagnostics?.meanPairAgreement || 0,
      localBeforeResidual: guardedAccepted
        ? guardedDiagnostics.localBeforeResidual
        : interiorAccepted
          ? interiorDiagnostics.localBeforeResidual
          : sceneAccepted
            ? sceneDiagnostics.localBeforeResidual
            : coreDiagnostics?.localBeforeResidual || 0,
      localAfterResidual: guardedAccepted
        ? guardedDiagnostics.localAfterResidual
        : interiorAccepted
          ? interiorDiagnostics.localAfterResidual
          : sceneAccepted
            ? sceneDiagnostics.localAfterResidual
            : coreDiagnostics?.localAfterResidual || 0,
      localImprovement: guardedAccepted
        ? guardedDiagnostics.localImprovement
        : interiorAccepted
          ? interiorDiagnostics.localImprovement
          : sceneAccepted
            ? sceneDiagnostics.localImprovement
            : coreDiagnostics?.localImprovement || 0,
      maxAppliedLumaDelta: Math.max(
        coreDiagnostics?.maxAppliedLumaDelta || 0,
        sceneDiagnostics?.maxAppliedLumaDelta || 0,
        interiorDiagnostics?.maxAppliedLumaDelta || 0,
        guardedDiagnostics?.maxAppliedLumaDelta || 0,
        lateDiagnostics?.axisSeam?.maxAppliedLumaDelta || 0
      ),
      outlineSafe: (coreDiagnostics?.outlineSafe ?? true)
        && (sceneDiagnostics?.outlineSafe ?? true)
        && (interiorDiagnostics?.outlineSafe ?? true)
        && (guardedDiagnostics?.outlineSafe ?? true)
        && (lateDiagnostics?.axisSeam?.outlineSafe ?? true)
        && (lateDiagnostics?.planeTone?.outlineSafe ?? true),
      globalSafe: (coreDiagnostics?.globalSafe ?? true)
        && (sceneDiagnostics?.globalSafe ?? true)
        && (interiorDiagnostics?.globalSafe ?? true)
        && (guardedDiagnostics?.globalSafe ?? true)
        && (lateDiagnostics?.axisSeam?.globalSafe ?? true)
        && (lateDiagnostics?.planeTone?.globalSafe ?? true),
      artifactSafe: (coreDiagnostics?.artifactSafe ?? true)
        && (sceneDiagnostics?.artifactSafe ?? true)
        && (interiorDiagnostics?.artifactSafe ?? true)
        && (guardedDiagnostics?.artifactSafe ?? true),
      coreAccepted,
      sceneProtectedContinuationEscalationAccepted: sceneAccepted,
      interiorGhostDissolveAccepted: interiorAccepted,
      guardedFaintGhostDissolveAccepted: guardedAccepted,
      lateResidualHarmonizerAccepted: lateAccepted,
      core: coreDiagnostics,
      sceneProtectedContinuationEscalation: sceneDiagnostics,
      interiorGhostDissolve: interiorDiagnostics,
      guardedFaintGhostDissolve: guardedDiagnostics,
      lateResidualHarmonizer: lateDiagnostics
    }
  };
}

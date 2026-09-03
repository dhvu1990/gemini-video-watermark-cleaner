import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureGeometricOutlineResidual } from './protectedResidualRescue.js';
import { sceneEdgeProtectionAt } from './sceneEdgeProtection.js';
import { buildContourSafetyBand } from './contourMicroInterpolation.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function rgbAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return [image.data[p], image.data[p + 1], image.data[p + 2]];
}

function rgbToYcbcr(rgb) {
  const y = luma(rgb);
  return [y, (rgb[2] - y) * 0.5389, (rgb[0] - y) * 0.6350];
}

function ycbcrToRgb(y, cb, cr) {
  const r = y + cr / 0.6350;
  const b = y + cb / 0.5389;
  const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return [clampByte(r), clampByte(g), clampByte(b)];
}

function optionalDeltaSafe(after, before, tolerance) {
  if (!Number.isFinite(after) || !Number.isFinite(before)) return true;
  return after <= before + tolerance;
}

const ORIENTATIONS = Array.from({ length: 8 }, (_, index) => index * Math.PI / 8);

function sampleCleanSide(image, alphaMap, safety, x, y, angle, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const maxAnchorSafetyWeight = Number.isFinite(options.maxAnchorSafetyWeight) ? options.maxAnchorSafetyWeight : 0.035;
  const maxRadius = Math.max(10, Math.min(34, Math.round(Number(options.maxRadius ?? 26))));
  const samplesNeeded = Math.max(1, Math.min(3, Math.round(Number(options.samplesPerSide ?? 2))));
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const samples = [];
  let lastX = -999;
  let lastY = -999;

  for (let distance = 2; distance <= maxRadius && samples.length < samplesNeeded; distance += 1) {
    const xx = Math.round(x + dx * distance * sign);
    const yy = Math.round(y + dy * distance * sign);
    if (xx < 2 || yy < 2 || xx >= image.width - 2 || yy >= image.height - 2) break;
    if (xx === lastX && yy === lastY) continue;
    lastX = xx;
    lastY = yy;
    const p = yy * image.width + xx;
    if ((alphaMap[p] || 0) > cleanAlpha) continue;
    if ((safety.weight[p] || 0) > maxAnchorSafetyWeight) continue;
    samples.push(rgbAt(image, xx, yy));
  }

  if (samples.length < samplesNeeded) return null;
  return [0, 1, 2].map((channel) => samples.reduce((sum, rgb) => sum + rgb[channel], 0) / samples.length);
}

function donorPairs(image, alphaMap, safety, x, y, options = {}) {
  const pairs = [];
  const pairSoft = Number(options.donorPairSoft ?? 4.0);
  const pairHard = Number(options.donorPairHard ?? 20.0);
  const minPairAgreement = Number.isFinite(options.minDonorPairAgreement) ? options.minDonorPairAgreement : 0.56;

  for (const angle of ORIENTATIONS) {
    const negative = sampleCleanSide(image, alphaMap, safety, x, y, angle, -1, options);
    const positive = sampleCleanSide(image, alphaMap, safety, x, y, angle, 1, options);
    if (!negative || !positive) continue;
    const negativeY = luma(negative);
    const positiveY = luma(positive);
    const chromaGap = Math.max(
      Math.abs(negative[0] - positive[0]),
      Math.abs(negative[1] - positive[1]),
      Math.abs(negative[2] - positive[2])
    );
    const gap = Math.abs(negativeY - positiveY) + chromaGap * 0.18;
    const agreement = 1 - smoothstep(pairSoft, pairHard, gap);
    if (agreement < minPairAgreement) continue;
    const target = [0, 1, 2].map((channel) => (negative[channel] + positive[channel]) * 0.5);
    pairs.push({ target, y: luma(target), agreement, angle, gap });
  }
  return pairs;
}

function clusteredConsensus(image, alphaMap, safety, x, y, options = {}) {
  const pairs = donorPairs(image, alphaMap, safety, x, y, options);
  const minAvailable = Math.max(2, Math.min(8, Math.round(Number(options.minAvailableDirections ?? 2))));
  if (pairs.length < minAvailable) return null;

  const tolerance = Math.max(2, Math.min(12, Number(options.clusterTolerance ?? 5.5)));
  let selected = [];
  let selectedScore = -Infinity;
  for (const center of pairs) {
    const cluster = pairs.filter((pair) => Math.abs(pair.y - center.y) <= tolerance);
    const agreement = cluster.reduce((sum, pair) => sum + pair.agreement, 0) / Math.max(1, cluster.length);
    const spread = cluster.length ? Math.max(...cluster.map((pair) => pair.y)) - Math.min(...cluster.map((pair) => pair.y)) : Infinity;
    const score = cluster.length * 3 + agreement - spread * 0.04;
    if (score > selectedScore) {
      selectedScore = score;
      selected = cluster;
    }
  }

  const minDirections = Math.max(2, Math.min(8, Math.round(Number(options.minClusterDirections ?? 2))));
  if (selected.length < minDirections) return null;
  const weightSum = selected.reduce((sum, pair) => sum + Math.max(0.05, pair.agreement), 0) || 1;
  const target = [0, 1, 2].map((channel) => selected.reduce(
    (sum, pair) => sum + pair.target[channel] * Math.max(0.05, pair.agreement),
    0
  ) / weightSum);
  const ys = selected.map((pair) => pair.y);
  const spread = Math.max(...ys) - Math.min(...ys);
  const consensus = 1 - smoothstep(
    Number(options.consensusSoft ?? 3.0),
    Number(options.consensusHard ?? 10.0),
    spread
  );
  const agreement = selected.reduce((sum, pair) => sum + pair.agreement, 0) / selected.length;
  const coverage = selected.length / pairs.length;
  const coverageConfidence = 0.72 + 0.28 * smoothstep(0.34, 0.72, coverage);

  return {
    target,
    targetY: luma(target),
    consensus: consensus * coverageConfidence,
    rawConsensus: consensus,
    agreement,
    spread,
    coverage,
    directions: selected.length,
    availableDirections: pairs.length,
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function outlineOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.outlineMinAlpha) ? options.outlineMinAlpha : 0.018,
    outlineMaxAlpha: Number.isFinite(options.outlineMaxAlpha) ? options.outlineMaxAlpha : 0.40,
    outlineResidualSoft: Number.isFinite(options.measureResidualSoft) ? options.measureResidualSoft : 0.30,
    outlineResidualHard: Number.isFinite(options.measureResidualHard) ? options.measureResidualHard : 3.4,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.76,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.68;
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, {
    ...options,
    maxAlpha,
    safetyRadius: Number.isFinite(options.safetyRadius) ? options.safetyRadius : 4,
    safetyTipExtraRadius: Number.isFinite(options.safetyTipExtraRadius) ? options.safetyTipExtraRadius : 2
  });
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.055;
  const minConsensus = Number.isFinite(options.minConsensus) ? options.minConsensus : 0.76;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.34;
  const absoluteSceneGuard = Number.isFinite(options.absoluteSceneGuard) ? options.absoluteSceneGuard : 0.995;
  const maxResidual = Number.isFinite(options.maxResidual) ? options.maxResidual : 18;
  const strength = clamp(Number(options.strength ?? 0.24), 0.08, 0.34);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.13), 0.04, 0.18);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 4.5), 1.5, 6);
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.30;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 2.8;
  const donorRangeMargin = Number.isFinite(options.donorRangeMargin) ? options.donorRangeMargin : 4.5;

  const guardedMinConsensus = Number.isFinite(options.guardedMinConsensus) ? options.guardedMinConsensus : 0.88;
  const guardedMinAgreement = Number.isFinite(options.guardedMinAgreement) ? options.guardedMinAgreement : 0.80;
  const guardedMinCoverage = Number.isFinite(options.guardedMinCoverage) ? options.guardedMinCoverage : 0.45;
  const guardedMinAvailableDirections = Math.max(3, Math.round(Number(options.guardedMinAvailableDirections ?? 3)));
  const guardedMaxSpread = Number.isFinite(options.guardedMaxSpread) ? options.guardedMaxSpread : 4.5;
  const guardedMaxResidual = Number.isFinite(options.guardedMaxResidual) ? options.guardedMaxResidual : 12;
  const guardedMaxAlpha = Number.isFinite(options.guardedMaxAlpha) ? options.guardedMaxAlpha : 0.52;
  const guardedMaxGradient = Number.isFinite(options.guardedMaxGradient) ? options.guardedMaxGradient : 96;
  const guardedMaxContinuity = Number.isFinite(options.guardedMaxContinuity) ? options.guardedMaxContinuity : 0.995;
  const guardedStrengthScale = clamp(Number(options.guardedStrengthScale ?? 0.30), 0.12, 0.42);
  const guardedMaxBlend = clamp(Number(options.guardedMaxBlend ?? 0.065), 0.025, 0.085);
  const guardedMaxLumaDelta = clamp(Number(options.guardedMaxLumaDelta ?? 3.25), 1.0, 4.0);

  let faintCandidates = 0;
  let consensusCandidates = 0;
  let correctedPixels = 0;
  let faintCorrectedPixels = 0;
  let guardedOverrideCandidates = 0;
  let guardedOverridePixels = 0;
  let sceneGuardedPixels = 0;
  let lowConsensusPixels = 0;
  let strongStructureVetoPixels = 0;
  let artifactVetoPixels = 0;
  let blendSum = 0;
  let consensusSum = 0;
  let agreementSum = 0;
  let localBeforeSum = 0;
  let localAfterSum = 0;
  let maxAppliedLumaDelta = 0;
  let guardedBlendSum = 0;
  let maxGuardedAppliedLumaDelta = 0;

  for (let y = 2; y < image.height - 2; y += 1) {
    for (let x = 2; x < image.width - 2; x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      faintCandidates += 1;

      const prediction = clusteredConsensus(image, alphaMap, safety, x, y, options);
      if (!prediction || prediction.consensus < minConsensus) {
        lowConsensusPixels += 1;
        continue;
      }
      consensusCandidates += 1;

      const currentRgb = rgbAt(image, x, y);
      const current = rgbToYcbcr(currentRgb);
      const target = rgbToYcbcr(prediction.target);
      const residual = target[0] - current[0];
      const residualAbs = Math.abs(residual);
      if (residualAbs > maxResidual) {
        strongStructureVetoPixels += 1;
        continue;
      }
      const residualGate = smoothstep(residualSoft, residualHard, residualAbs);
      if (residualGate <= 0) continue;

      const scene = sceneEdgeProtectionAt(image, safety.guardAlpha, x, y, options.sceneEdgeOptions || {});
      const guarded = scene.weight >= hardSceneGuard;
      if (scene.weight >= absoluteSceneGuard) {
        sceneGuardedPixels += 1;
        continue;
      }

      let localStrength = strength;
      let localMaxBlend = maxBlend;
      let localMaxLumaDelta = maxLumaDelta;
      let sceneConfidence = clamp(1 - scene.weight * 0.35, 0.52, 1);
      if (guarded) {
        guardedOverrideCandidates += 1;
        const guardedEvidence = prediction.consensus >= guardedMinConsensus
          && prediction.agreement >= guardedMinAgreement
          && prediction.coverage >= guardedMinCoverage
          && prediction.availableDirections >= guardedMinAvailableDirections
          && prediction.spread <= guardedMaxSpread
          && residualAbs <= guardedMaxResidual
          && alpha <= guardedMaxAlpha
          && scene.gradient <= guardedMaxGradient
          && scene.continuity <= guardedMaxContinuity;
        if (!guardedEvidence) {
          sceneGuardedPixels += 1;
          continue;
        }
        localStrength *= guardedStrengthScale;
        localMaxBlend = Math.min(localMaxBlend, guardedMaxBlend);
        localMaxLumaDelta = Math.min(localMaxLumaDelta, guardedMaxLumaDelta);
        sceneConfidence = 1;
      }

      const alphaWeight = 0.76 + 0.24 * (1 - smoothstep(0.42, maxAlpha, alpha));
      const confidence = prediction.consensus
        * prediction.agreement
        * residualGate
        * alphaWeight
        * sceneConfidence;
      const blend = Math.min(localMaxBlend, localStrength * confidence);
      if (blend < 0.012) continue;

      // Near protected scene structure, cap the actual blended delta rather than
      // shrinking an already capped residual. Otherwise sub-0.5 luma changes are
      // rounded away by Uint8ClampedArray and the guarded micro path becomes a no-op.
      const requestedDelta = guarded
        ? clamp(residual * blend, -localMaxLumaDelta, localMaxLumaDelta)
        : clamp(residual, -localMaxLumaDelta, localMaxLumaDelta) * blend;
      const candidateY = current[0] + requestedDelta;
      const currentResidual = residualAbs;
      if (Math.abs(target[0] - candidateY) + 0.015 >= currentResidual) {
        artifactVetoPixels += 1;
        continue;
      }

      const donorMin = prediction.minY - donorRangeMargin;
      const donorMax = prediction.maxY + donorRangeMargin;
      const currentOutside = current[0] < donorMin || current[0] > donorMax;
      if (!currentOutside && (candidateY < donorMin || candidateY > donorMax)) {
        artifactVetoPixels += 1;
        continue;
      }

      const chromaBlend = guarded
        ? Math.min(0.008, Math.max(0.002, blend * 0.08))
        : Math.min(0.018, Math.max(0.003, blend * 0.10));
      const cb = current[1] + clamp(target[1] - current[1], -3, 3) * chromaBlend;
      const cr = current[2] + clamp(target[2] - current[2], -3, 3) * chromaBlend;
      const nextRgb = ycbcrToRgb(candidateY, cb, cr);
      const nextY = luma(nextRgb);
      if (Math.abs(target[0] - nextY) + 0.01 >= currentResidual) {
        artifactVetoPixels += 1;
        continue;
      }

      const idx = p * 4;
      if (nextRgb[0] === image.data[idx] && nextRgb[1] === image.data[idx + 1] && nextRgb[2] === image.data[idx + 2]) continue;
      data[idx] = nextRgb[0];
      data[idx + 1] = nextRgb[1];
      data[idx + 2] = nextRgb[2];
      correctedPixels += 1;
      if (alpha < 0.12) faintCorrectedPixels += 1;
      if (guarded) {
        guardedOverridePixels += 1;
        guardedBlendSum += blend;
        maxGuardedAppliedLumaDelta = Math.max(maxGuardedAppliedLumaDelta, Math.abs(nextY - current[0]));
      }
      blendSum += blend;
      consensusSum += prediction.consensus;
      agreementSum += prediction.agreement;
      localBeforeSum += currentResidual;
      localAfterSum += Math.abs(target[0] - nextY);
      maxAppliedLumaDelta = Math.max(maxAppliedLumaDelta, Math.abs(nextY - current[0]));
    }
  }

  const localBeforeResidual = correctedPixels ? localBeforeSum / correctedPixels : 0;
  const localAfterResidual = correctedPixels ? localAfterSum / correctedPixels : 0;
  const localImprovement = localBeforeResidual > 1e-9
    ? (localBeforeResidual - localAfterResidual) / localBeforeResidual
    : 0;

  return {
    width: image.width,
    height: image.height,
    data,
    faintCandidates,
    consensusCandidates,
    correctedPixels,
    faintCorrectedPixels,
    guardedOverrideCandidates,
    guardedOverridePixels,
    sceneGuardedPixels,
    lowConsensusPixels,
    strongStructureVetoPixels,
    artifactVetoPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanConsensus: correctedPixels ? consensusSum / correctedPixels : 0,
    meanAgreement: correctedPixels ? agreementSum / correctedPixels : 0,
    guardedMeanBlend: guardedOverridePixels ? guardedBlendSum / guardedOverridePixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    maxAppliedLumaDelta,
    maxGuardedAppliedLumaDelta
  };
}

export function applyGuardedFaintGhostDissolve(image, alphaMap, options = {}) {
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineOptions(options));
  const minAlphaPixels = Math.max(8, Math.round(Number(options.minAlphaPixels ?? 10)));
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.055;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.68;
  let alphaPixels = 0;
  for (let i = 0; i < alphaMap.length; i += 1) {
    const alpha = alphaMap[i] || 0;
    if (alpha >= minAlpha && alpha <= maxAlpha) alphaPixels += 1;
  }
  const eligible = options.enabled !== false && alphaPixels >= minAlphaPixels;

  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      guardedFaintGhostDissolve: {
        eligible,
        attempted: false,
        accepted: false,
        profile: 'none',
        alphaPixels,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        beforeOutline,
        afterOutline: beforeOutline,
        correctedPixels: 0,
        guardedOverridePixels: 0
      }
    };
  }

  const candidate = buildCandidate(image, alphaMap, options);
  const candidateImage = { width: image.width, height: image.height, data: candidate.data };
  const afterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const afterOutline = measureGeometricOutlineResidual(candidateImage, alphaMap, outlineOptions(options));
  const minCorrectedPixels = Math.max(2, Math.round(Number(options.minCorrectedPixels ?? 3)));
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.025;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.13;
  const maxArtifactVetoFraction = Number.isFinite(options.maxArtifactVetoFraction) ? options.maxArtifactVetoFraction : 0.80;
  const attempts = candidate.correctedPixels + candidate.artifactVetoPixels;
  const artifactVetoFraction = attempts ? candidate.artifactVetoPixels / attempts : 0;
  const outlineSafe = afterOutline.score <= beforeOutline.score * Number(options.maxOutlineRatio ?? 1.004) + 0.020;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.0035 + 0.025
    && afterGlobal.luma <= beforeGlobal.luma * 1.004 + 0.030
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.003 + 0.16
    && optionalDeltaSafe(afterGlobal.darkCandidateMean, beforeGlobal.darkCandidateMean, 0.14)
    && optionalDeltaSafe(afterGlobal.darkCandidatePeak, beforeGlobal.darkCandidatePeak, 0.55)
    && optionalDeltaSafe(afterGlobal.clipFraction, beforeGlobal.clipFraction, 0.001);
  const artifactSafe = candidate.meanBlend <= maxMeanBlend + 1e-6
    && artifactVetoFraction <= maxArtifactVetoFraction;
  const guardedSafe = candidate.guardedMeanBlend <= Number(options.maxGuardedMeanBlend ?? 0.070) + 1e-6
    && candidate.maxGuardedAppliedLumaDelta <= Number(options.maxGuardedAppliedLumaDelta ?? 3.5) + 1e-6;
  const accepted = candidate.correctedPixels >= minCorrectedPixels
    && candidate.localImprovement >= minLocalImprovement
    && candidate.meanConsensus >= Number(options.minAcceptedConsensus ?? 0.76)
    && outlineSafe
    && globalSafe
    && artifactSafe
    && guardedSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? new Uint8ClampedArray(candidate.data) : new Uint8ClampedArray(image.data),
    guardedFaintGhostDissolve: {
      eligible,
      attempted: candidate.consensusCandidates > 0,
      accepted,
      profile: 'guarded-faint-ghost-dissolve',
      alphaPixels,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal,
      beforeOutline,
      afterOutline: accepted ? afterOutline : beforeOutline,
      candidateAfterOutline: afterOutline,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      faintCandidates: candidate.faintCandidates,
      faintCorrectedPixels: accepted ? candidate.faintCorrectedPixels : 0,
      candidateFaintCorrectedPixels: candidate.faintCorrectedPixels,
      consensusCandidates: candidate.consensusCandidates,
      guardedOverrideCandidates: candidate.guardedOverrideCandidates,
      guardedOverridePixels: accepted ? candidate.guardedOverridePixels : 0,
      candidateGuardedOverridePixels: candidate.guardedOverridePixels,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      lowConsensusPixels: candidate.lowConsensusPixels,
      strongStructureVetoPixels: candidate.strongStructureVetoPixels,
      artifactVetoPixels: candidate.artifactVetoPixels,
      artifactVetoFraction,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      meanConsensus: candidate.meanConsensus,
      meanAgreement: candidate.meanAgreement,
      guardedMeanBlend: candidate.guardedMeanBlend,
      localBeforeResidual: candidate.localBeforeResidual,
      localAfterResidual: candidate.localAfterResidual,
      localImprovement: candidate.localImprovement,
      maxAppliedLumaDelta: candidate.maxAppliedLumaDelta,
      maxGuardedAppliedLumaDelta: candidate.maxGuardedAppliedLumaDelta,
      outlineSafe,
      globalSafe,
      artifactSafe,
      guardedSafe,
      minCorrectedPixels,
      minLocalImprovement,
      maxMeanBlend,
      maxArtifactVetoFraction
    }
  };
}

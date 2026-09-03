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

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

const CONSENSUS_ORIENTATIONS = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4];

function sampleCleanSide(image, alphaMap, safety, x, y, angle, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const maxAnchorSafetyWeight = Number.isFinite(options.maxAnchorSafetyWeight) ? options.maxAnchorSafetyWeight : 0.040;
  const maxRadius = Math.max(8, Math.min(30, Math.round(Number(options.maxRadius ?? 24))));
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

function directionalConsensus(image, alphaMap, safety, x, y, options = {}) {
  const pairTargets = [];
  const minPairAgreement = Number.isFinite(options.minDonorPairAgreement) ? options.minDonorPairAgreement : 0.62;
  const pairSoft = Number(options.donorPairSoft ?? 4.0);
  const pairHard = Number(options.donorPairHard ?? 18.0);

  for (const angle of CONSENSUS_ORIENTATIONS) {
    const left = sampleCleanSide(image, alphaMap, safety, x, y, angle, -1, options);
    const right = sampleCleanSide(image, alphaMap, safety, x, y, angle, 1, options);
    if (!left || !right) continue;
    const leftY = luma(left);
    const rightY = luma(right);
    const chromaGap = Math.max(
      Math.abs(left[0] - right[0]),
      Math.abs(left[1] - right[1]),
      Math.abs(left[2] - right[2])
    );
    const gap = Math.abs(leftY - rightY) + chromaGap * 0.20;
    const agreement = 1 - smoothstep(pairSoft, pairHard, gap);
    if (agreement < minPairAgreement) continue;
    const target = [0, 1, 2].map((channel) => (left[channel] + right[channel]) * 0.5);
    pairTargets.push({ target, y: luma(target), agreement });
  }

  const minDirections = Math.max(2, Math.min(4, Math.round(Number(options.minConsensusDirections ?? 2))));
  if (pairTargets.length < minDirections) return null;
  const target = [0, 1, 2].map((channel) => median(pairTargets.map((pair) => pair.target[channel])));
  const ys = pairTargets.map((pair) => pair.y);
  const spread = Math.max(...ys) - Math.min(...ys);
  const consensus = 1 - smoothstep(
    Number(options.consensusSoft ?? 4.5),
    Number(options.consensusHard ?? 14.0),
    spread
  );
  const agreement = pairTargets.reduce((sum, pair) => sum + pair.agreement, 0) / pairTargets.length;
  return {
    target,
    targetY: luma(target),
    consensus,
    agreement,
    spread,
    directions: pairTargets.length,
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function outlineOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.outlineMinAlpha) ? options.outlineMinAlpha : 0.018,
    outlineMaxAlpha: Number.isFinite(options.outlineMaxAlpha) ? options.outlineMaxAlpha : 0.40,
    outlineResidualSoft: Number.isFinite(options.measureResidualSoft) ? options.measureResidualSoft : 0.35,
    outlineResidualHard: Number.isFinite(options.measureResidualHard) ? options.measureResidualHard : 3.6,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.72,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, {
    ...options,
    maxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.82,
    safetyRadius: Number.isFinite(options.safetyRadius) ? options.safetyRadius : 4,
    safetyTipExtraRadius: Number.isFinite(options.safetyTipExtraRadius) ? options.safetyTipExtraRadius : 2
  });
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.12;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.82;
  const minConsensus = Number.isFinite(options.minConsensus) ? options.minConsensus : 0.72;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.36;
  const strength = clamp(Number(options.strength ?? 0.28), 0.10, 0.38);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.18), 0.05, 0.22);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 6), 2, 8);
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.70;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 4.2;
  const donorRangeMargin = Number.isFinite(options.donorRangeMargin) ? options.donorRangeMargin : 5.5;

  let interiorCandidates = 0;
  let consensusCandidates = 0;
  let correctedPixels = 0;
  let sceneGuardedPixels = 0;
  let lowConsensusPixels = 0;
  let artifactVetoPixels = 0;
  let blendSum = 0;
  let consensusSum = 0;
  let localBeforeSum = 0;
  let localAfterSum = 0;
  let maxAppliedLumaDelta = 0;

  for (let y = 2; y < image.height - 2; y += 1) {
    for (let x = 2; x < image.width - 2; x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      interiorCandidates += 1;

      const scene = sceneEdgeProtectionAt(image, safety.guardAlpha, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        sceneGuardedPixels += 1;
        continue;
      }

      const prediction = directionalConsensus(image, alphaMap, safety, x, y, options);
      if (!prediction || prediction.consensus < minConsensus) {
        lowConsensusPixels += 1;
        continue;
      }
      consensusCandidates += 1;

      const currentRgb = rgbAt(image, x, y);
      const current = rgbToYcbcr(currentRgb);
      const target = rgbToYcbcr(prediction.target);
      const residual = target[0] - current[0];
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0) continue;

      const alphaWeight = 0.72 + 0.28 * (1 - smoothstep(0.66, maxAlpha, alpha));
      const confidence = prediction.consensus * prediction.agreement * residualGate * alphaWeight;
      const blend = Math.min(maxBlend, strength * confidence);
      if (blend < 0.020) continue;

      const requestedDelta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const candidateY = current[0] + requestedDelta;
      const currentResidual = Math.abs(residual);
      if (Math.abs(target[0] - candidateY) + 0.02 >= currentResidual) {
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

      const chromaBlend = Math.min(0.03, Math.max(0.005, blend * 0.08));
      const cb = current[1] + clamp(target[1] - current[1], -4, 4) * chromaBlend;
      const cr = current[2] + clamp(target[2] - current[2], -4, 4) * chromaBlend;
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
      blendSum += blend;
      consensusSum += prediction.consensus;
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
    interiorCandidates,
    consensusCandidates,
    correctedPixels,
    sceneGuardedPixels,
    lowConsensusPixels,
    artifactVetoPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanConsensus: correctedPixels ? consensusSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    maxAppliedLumaDelta
  };
}

export function applyInteriorGhostDissolve(image, alphaMap, options = {}) {
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineOptions(options));
  const minAlphaPixels = Math.max(8, Math.round(Number(options.minAlphaPixels ?? 12)));
  let alphaPixels = 0;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.12;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.82;
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
      interiorGhostDissolve: {
        eligible,
        attempted: false,
        accepted: false,
        profile: 'none',
        alphaPixels,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        beforeOutline,
        afterOutline: beforeOutline,
        correctedPixels: 0
      }
    };
  }

  const candidate = buildCandidate(image, alphaMap, options);
  const candidateImage = { width: image.width, height: image.height, data: candidate.data };
  const afterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const afterOutline = measureGeometricOutlineResidual(candidateImage, alphaMap, outlineOptions(options));
  const minCorrectedPixels = Math.max(3, Math.round(Number(options.minCorrectedPixels ?? 4)));
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.035;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.18;
  const maxArtifactVetoFraction = Number.isFinite(options.maxArtifactVetoFraction) ? options.maxArtifactVetoFraction : 0.72;
  const attempts = candidate.correctedPixels + candidate.artifactVetoPixels;
  const artifactVetoFraction = attempts ? candidate.artifactVetoPixels / attempts : 0;
  const outlineSafe = afterOutline.score <= beforeOutline.score * Number(options.maxOutlineRatio ?? 1.006) + 0.025;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.004 + 0.030
    && afterGlobal.luma <= beforeGlobal.luma * 1.005 + 0.040
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.004 + 0.20
    && optionalDeltaSafe(afterGlobal.darkCandidateMean, beforeGlobal.darkCandidateMean, 0.18)
    && optionalDeltaSafe(afterGlobal.darkCandidatePeak, beforeGlobal.darkCandidatePeak, 0.75)
    && optionalDeltaSafe(afterGlobal.clipFraction, beforeGlobal.clipFraction, 0.001);
  const artifactSafe = candidate.meanBlend <= maxMeanBlend + 1e-6
    && artifactVetoFraction <= maxArtifactVetoFraction;
  const accepted = candidate.correctedPixels >= minCorrectedPixels
    && candidate.localImprovement >= minLocalImprovement
    && candidate.meanConsensus >= Number(options.minAcceptedConsensus ?? 0.72)
    && outlineSafe
    && globalSafe
    && artifactSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? new Uint8ClampedArray(candidate.data) : new Uint8ClampedArray(image.data),
    interiorGhostDissolve: {
      eligible,
      attempted: candidate.consensusCandidates > 0,
      accepted,
      profile: 'interior-ghost-dissolve',
      alphaPixels,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal,
      beforeOutline,
      afterOutline: accepted ? afterOutline : beforeOutline,
      candidateAfterOutline: afterOutline,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      interiorCandidates: candidate.interiorCandidates,
      consensusCandidates: candidate.consensusCandidates,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      lowConsensusPixels: candidate.lowConsensusPixels,
      artifactVetoPixels: candidate.artifactVetoPixels,
      artifactVetoFraction,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      meanConsensus: candidate.meanConsensus,
      localBeforeResidual: candidate.localBeforeResidual,
      localAfterResidual: candidate.localAfterResidual,
      localImprovement: candidate.localImprovement,
      maxAppliedLumaDelta: candidate.maxAppliedLumaDelta,
      outlineSafe,
      globalSafe,
      artifactSafe,
      minCorrectedPixels,
      minLocalImprovement,
      maxMeanBlend,
      maxArtifactVetoFraction
    }
  };
}

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

function averageRgb(samples) {
  return [0, 1, 2].map((channel) => samples.reduce((sum, sample) => sum + sample.rgb[channel], 0) / samples.length);
}

function sampleSide(image, alphaMap, safety, x, y, angle, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const maxAnchorSafetyWeight = Number.isFinite(options.maxAnchorSafetyWeight) ? options.maxAnchorSafetyWeight : 0.045;
  const maxRadius = Math.max(7, Math.min(28, Math.round(Number(options.maxRadius ?? 22))));
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
    samples.push({ rgb: rgbAt(image, xx, yy), distance });
  }

  if (samples.length < samplesNeeded) return null;
  const rgb = averageRgb(samples);
  return { rgb, y: luma(rgb), distance: samples[0].distance };
}

function samplePair(image, alphaMap, safety, x, y, angle, options = {}) {
  const left = sampleSide(image, alphaMap, safety, x, y, angle, -1, options);
  const right = sampleSide(image, alphaMap, safety, x, y, angle, 1, options);
  if (!left || !right) return null;
  const target = [0, 1, 2].map((channel) => (left.rgb[channel] + right.rgb[channel]) * 0.5);
  const lumaGap = Math.abs(left.y - right.y);
  const chromaGap = Math.max(
    Math.abs(left.rgb[0] - right.rgb[0]),
    Math.abs(left.rgb[1] - right.rgb[1]),
    Math.abs(left.rgb[2] - right.rgb[2])
  );
  const gap = lumaGap + chromaGap * 0.20;
  const agreement = 1 - smoothstep(
    Number(options.pairAgreementSoft ?? 3.5),
    Number(options.pairAgreementHard ?? 18),
    gap
  );
  return {
    angle,
    target,
    targetY: luma(target),
    agreement,
    lumaGap,
    chromaGap,
    meanDistance: (left.distance + right.distance) * 0.5
  };
}

function dominantScenePrediction(image, alphaMap, safety, x, y, options = {}) {
  const pairs = ORIENTATIONS
    .map((angle) => samplePair(image, alphaMap, safety, x, y, angle, options))
    .filter(Boolean);
  if (!pairs.length) return null;

  for (const pair of pairs) {
    const perpendicularAngle = (pair.angle + Math.PI / 2) % Math.PI;
    const perpendicular = pairs.reduce((best, candidate) => {
      const direct = Math.abs(candidate.angle - perpendicularAngle);
      const wrapped = Math.PI - direct;
      const distance = Math.min(direct, wrapped);
      return !best || distance < best.distance ? { pair: candidate, distance } : best;
    }, null)?.pair;
    const evidenceDelta = perpendicular ? Math.abs(pair.targetY - perpendicular.targetY) : 0;
    pair.structureEvidence = smoothstep(
      Number(options.structureEvidenceSoft ?? 4.0),
      Number(options.structureEvidenceHard ?? 18.0),
      evidenceDelta
    );
    pair.score = pair.agreement * (0.60 + pair.structureEvidence * 0.40)
      - pair.meanDistance * 0.0025;
  }

  pairs.sort((a, b) => b.score - a.score);
  const best = pairs[0];
  const second = pairs[1] || null;
  const adjacentSupport = second
    ? second.agreement >= Number(options.adjacentSupportAgreement ?? 0.78)
      && Math.min(Math.abs(second.angle - best.angle), Math.PI - Math.abs(second.angle - best.angle)) <= Math.PI / 4
    : false;
  return { ...best, adjacentSupport, pairCount: pairs.length };
}

function outlineOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.minAlpha) ? options.minAlpha : 0.012,
    outlineMaxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.68,
    outlineResidualSoft: Number.isFinite(options.measureResidualSoft) ? options.measureResidualSoft : 0.32,
    outlineResidualHard: Number.isFinite(options.measureResidualHard) ? options.measureResidualHard : 3.4,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.96,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, {
    ...options,
    maxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.68,
    safetyRadius: Number.isFinite(options.safetyRadius) ? options.safetyRadius : 4,
    safetyTipExtraRadius: Number.isFinite(options.safetyTipExtraRadius) ? options.safetyTipExtraRadius : 2
  });
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.012;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.68;
  const minPairAgreement = Number.isFinite(options.minPairAgreement) ? options.minPairAgreement : 0.80;
  const strongPairAgreement = Number.isFinite(options.strongPairAgreement) ? options.strongPairAgreement : 0.90;
  const minStructureEvidence = Number.isFinite(options.minStructureEvidence) ? options.minStructureEvidence : 0.28;
  const strongStructureEvidence = Number.isFinite(options.strongStructureEvidence) ? options.strongStructureEvidence : 0.52;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.70;
  const absoluteSceneGuard = Number.isFinite(options.absoluteSceneGuard) ? options.absoluteSceneGuard : 0.985;
  const strength = clamp(Number(options.strength ?? 0.36), 0.14, 0.50);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.20), 0.06, 0.24);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 7), 2, 9);
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.40;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 3.4;
  const localMargin = Number.isFinite(options.localMargin) ? options.localMargin : 8;

  let footprintCandidates = 0;
  let directionalCandidates = 0;
  let correctedPixels = 0;
  let sceneGuardedPixels = 0;
  let sceneOverridePixels = 0;
  let artifactVetoPixels = 0;
  let lineLikePixels = 0;
  let curvedTexturePixels = 0;
  let blendSum = 0;
  let agreementSum = 0;
  let evidenceSum = 0;
  let localBeforeSum = 0;
  let localAfterSum = 0;
  let maxAppliedLumaDelta = 0;

  for (let y = 2; y < image.height - 2; y += 1) {
    for (let x = 2; x < image.width - 2; x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      footprintCandidates += 1;

      const prediction = dominantScenePrediction(image, alphaMap, safety, x, y, options);
      if (!prediction
        || prediction.agreement < minPairAgreement
        || prediction.structureEvidence < minStructureEvidence) continue;
      directionalCandidates += 1;

      const scene = sceneEdgeProtectionAt(image, safety.guardAlpha, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= absoluteSceneGuard) {
        sceneGuardedPixels += 1;
        continue;
      }
      const strongStructure = prediction.agreement >= strongPairAgreement
        && prediction.structureEvidence >= strongStructureEvidence;
      if (scene.weight >= hardSceneGuard && !strongStructure) {
        sceneGuardedPixels += 1;
        continue;
      }
      if (scene.weight >= hardSceneGuard && strongStructure) sceneOverridePixels += 1;

      const currentRgb = rgbAt(image, x, y);
      const current = rgbToYcbcr(currentRgb);
      const target = rgbToYcbcr(prediction.target);
      const residual = target[0] - current[0];
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0) continue;

      const evidenceWeight = 0.55 + prediction.structureEvidence * 0.45;
      const sceneAttenuation = scene.weight >= hardSceneGuard ? 0.48 : clamp(1 - scene.weight * 0.85, 0.35, 1);
      const alphaAttenuation = 1 - 0.20 * smoothstep(0.52, maxAlpha, alpha);
      const confidence = prediction.agreement * evidenceWeight * residualGate * sceneAttenuation * alphaAttenuation;
      const blend = Math.min(maxBlend, strength * confidence);
      if (blend < 0.022) continue;

      const requestedDelta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const candidateY = current[0] + requestedDelta;
      const currentResidual = Math.abs(residual);
      const candidateResidual = Math.abs(target[0] - candidateY);
      if (candidateResidual + 0.02 >= currentResidual) {
        artifactVetoPixels += 1;
        continue;
      }

      const targetMin = target[0] - localMargin;
      const targetMax = target[0] + localMargin;
      const currentOutside = current[0] < targetMin || current[0] > targetMax;
      if (!currentOutside && (candidateY < targetMin || candidateY > targetMax)) {
        artifactVetoPixels += 1;
        continue;
      }

      const chromaBlend = Math.min(0.04, Math.max(0.006, blend * 0.10));
      const cb = current[1] + clamp(target[1] - current[1], -5, 5) * chromaBlend;
      const cr = current[2] + clamp(target[2] - current[2], -5, 5) * chromaBlend;
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
      if (prediction.structureEvidence >= 0.65) lineLikePixels += 1;
      if (prediction.adjacentSupport && prediction.structureEvidence < 0.65) curvedTexturePixels += 1;
      blendSum += blend;
      agreementSum += prediction.agreement;
      evidenceSum += prediction.structureEvidence;
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
  const profile = sceneOverridePixels > 0 || lineLikePixels >= Math.max(2, correctedPixels * 0.35)
    ? 'scene-protected-line-continuation'
    : curvedTexturePixels >= Math.max(2, correctedPixels * 0.20)
      ? 'scene-protected-curved-texture'
      : 'scene-directional-continuation';

  return {
    width: image.width,
    height: image.height,
    data,
    footprintCandidates,
    directionalCandidates,
    correctedPixels,
    sceneGuardedPixels,
    sceneOverridePixels,
    artifactVetoPixels,
    lineLikePixels,
    curvedTexturePixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanPairAgreement: correctedPixels ? agreementSum / correctedPixels : 0,
    meanStructureEvidence: correctedPixels ? evidenceSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    maxAppliedLumaDelta,
    profile
  };
}

export function applySceneProtectedContinuationEscalation(image, alphaMap, options = {}) {
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineOptions(options));
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const eligible = options.enabled !== false
    && beforeOutline.score >= Number(options.minOutlineScore ?? 0.48)
    && beforeOutline.candidateDensity >= Number(options.minOutlineDensity ?? 0.022)
    && beforeOutline.samples >= Math.max(4, Math.round(Number(options.minOutlineSamples ?? 6)));

  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      sceneProtectedContinuationEscalation: {
        eligible,
        attempted: false,
        accepted: false,
        profile: 'none',
        beforeOutline,
        afterOutline: beforeOutline,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        correctedPixels: 0
      }
    };
  }

  const candidate = buildCandidate(image, alphaMap, options);
  const candidateImage = { width: image.width, height: image.height, data: candidate.data };
  const afterOutline = measureGeometricOutlineResidual(candidateImage, alphaMap, outlineOptions(options));
  const afterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const minCorrectedPixels = Math.max(2, Math.round(Number(options.minCorrectedPixels ?? 3)));
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.035;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.20;
  const maxArtifactVetoFraction = Number.isFinite(options.maxArtifactVetoFraction) ? options.maxArtifactVetoFraction : 0.76;
  const attempts = candidate.correctedPixels + candidate.artifactVetoPixels;
  const artifactVetoFraction = attempts ? candidate.artifactVetoPixels / attempts : 0;
  const outlineSafe = beforeOutline.score < 0.18
    ? afterOutline.score <= 0.30
    : afterOutline.score <= beforeOutline.score * Number(options.maxOutlineRatio ?? 1.003) + 0.018;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.003 + 0.025
    && afterGlobal.luma <= beforeGlobal.luma * 1.004 + 0.035
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.004 + 0.22
    && optionalDeltaSafe(afterGlobal.darkCandidateMean, beforeGlobal.darkCandidateMean, 0.20)
    && optionalDeltaSafe(afterGlobal.darkCandidatePeak, beforeGlobal.darkCandidatePeak, 0.80)
    && optionalDeltaSafe(afterGlobal.clipFraction, beforeGlobal.clipFraction, 0.001);
  const artifactSafe = candidate.meanBlend <= maxMeanBlend + 1e-6
    && artifactVetoFraction <= maxArtifactVetoFraction;
  const accepted = candidate.correctedPixels >= minCorrectedPixels
    && candidate.localImprovement >= minLocalImprovement
    && candidate.meanPairAgreement >= Number(options.minAcceptedPairAgreement ?? 0.80)
    && candidate.meanStructureEvidence >= Number(options.minAcceptedStructureEvidence ?? 0.28)
    && outlineSafe
    && globalSafe
    && artifactSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? new Uint8ClampedArray(candidate.data) : new Uint8ClampedArray(image.data),
    sceneProtectedContinuationEscalation: {
      eligible,
      attempted: candidate.directionalCandidates > 0,
      accepted,
      profile: candidate.profile,
      beforeOutline,
      afterOutline: accepted ? afterOutline : beforeOutline,
      candidateAfterOutline: afterOutline,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      footprintCandidates: candidate.footprintCandidates,
      directionalCandidates: candidate.directionalCandidates,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      sceneOverridePixels: candidate.sceneOverridePixels,
      artifactVetoPixels: candidate.artifactVetoPixels,
      artifactVetoFraction,
      lineLikePixels: candidate.lineLikePixels,
      curvedTexturePixels: candidate.curvedTexturePixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      meanPairAgreement: candidate.meanPairAgreement,
      meanStructureEvidence: candidate.meanStructureEvidence,
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

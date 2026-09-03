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

function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) {
    return { gx: 0, gy: 0, magnitude: 0 };
  }
  const p = y * width + x;
  const gx = ((alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0)) * 0.5;
  const gy = ((alphaMap[p + width] || 0) - (alphaMap[p - width] || 0)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function rotate(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c];
}

function baseTangent(alphaMap, width, height, safety, x, y) {
  const gradient = alphaGradient(alphaMap, width, height, x, y);
  if (gradient.magnitude >= 0.0015) {
    return {
      x: -gradient.gy / gradient.magnitude,
      y: gradient.gx / gradient.magnitude,
      gradient: gradient.magnitude,
      fallback: false
    };
  }
  const bounds = safety?.bounds;
  if (!bounds) return null;
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  const rx = x - cx;
  const ry = y - cy;
  const magnitude = Math.hypot(rx, ry);
  if (magnitude < 1e-6) return null;
  return {
    x: -ry / magnitude,
    y: rx / magnitude,
    gradient: gradient.magnitude,
    fallback: true
  };
}

function sampleSide(image, alphaMap, x, y, dx, dy, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const maxRadius = Math.max(6, Math.min(24, Math.round(Number(options.maxRadius ?? 18))));
  const samplesNeeded = Math.max(1, Math.min(3, Math.round(Number(options.samplesPerSide ?? 2))));
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
    samples.push({ distance, rgb: rgbAt(image, xx, yy) });
  }
  if (samples.length < samplesNeeded) return null;
  const rgb = [0, 1, 2].map((channel) => samples.reduce((sum, sample) => sum + sample.rgb[channel], 0) / samples.length);
  return { rgb, y: luma(rgb), distance: samples[0].distance };
}

function tangentPrediction(image, alphaMap, safety, x, y, options = {}) {
  const tangent = baseTangent(alphaMap, image.width, image.height, safety, x, y);
  if (!tangent) return null;
  const angleOffsets = options.angleOffsets || [0, Math.PI / 18, -Math.PI / 18, Math.PI / 9, -Math.PI / 9];
  const pairAgreementSoft = Number(options.pairAgreementSoft ?? 4.5);
  const pairAgreementHard = Number(options.pairAgreementHard ?? 20);
  const candidates = [];

  for (const angle of angleOffsets) {
    const [dx, dy] = rotate(tangent.x, tangent.y, angle);
    const left = sampleSide(image, alphaMap, x, y, dx, dy, -1, options);
    const right = sampleSide(image, alphaMap, x, y, dx, dy, 1, options);
    if (!left || !right) continue;
    const lumaGap = Math.abs(left.y - right.y);
    const chromaGap = Math.max(
      Math.abs(left.rgb[0] - right.rgb[0]),
      Math.abs(left.rgb[1] - right.rgb[1]),
      Math.abs(left.rgb[2] - right.rgb[2])
    );
    const agreement = 1 - smoothstep(pairAgreementSoft, pairAgreementHard, lumaGap + chromaGap * 0.22);
    const target = [0, 1, 2].map((channel) => (left.rgb[channel] + right.rgb[channel]) * 0.5);
    const score = (1 - agreement) * 8 + Math.abs(angle) * 1.8 + (left.distance + right.distance) * 0.025;
    candidates.push({ target, targetY: luma(target), agreement, angle, dx, dy, lumaGap, chromaGap, score });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return { ...candidates[0], tangent };
}

function outlineOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.minAlpha) ? options.minAlpha : 0.006,
    outlineMaxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.30,
    outlineResidualSoft: Number.isFinite(options.measureResidualSoft) ? options.measureResidualSoft : 0.28,
    outlineResidualHard: Number.isFinite(options.measureResidualHard) ? options.measureResidualHard : 3.2,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.72,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, {
    ...options,
    maxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.30,
    safetyRadius: Number.isFinite(options.safetyRadius) ? options.safetyRadius : 4,
    safetyTipExtraRadius: Number.isFinite(options.safetyTipExtraRadius) ? options.safetyTipExtraRadius : 2
  });
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.006;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.30;
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.0018;
  const fullGradient = Number.isFinite(options.fullAlphaGradient) ? options.fullAlphaGradient : 0.030;
  const minAgreement = Number.isFinite(options.minPairAgreement) ? options.minPairAgreement : 0.62;
  const strongAgreement = Number.isFinite(options.strongPairAgreement) ? options.strongPairAgreement : 0.84;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.76;
  const lineSceneGuard = Number.isFinite(options.lineSceneGuard) ? options.lineSceneGuard : 0.94;
  const maxBlend = clamp(Number(options.maxBlend ?? 0.20), 0.06, 0.24);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 6), 2, 8);
  const strength = clamp(Number(options.strength ?? 0.34), 0.12, 0.48);
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.38;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 3.2;

  let contourCandidates = 0;
  let pairedCandidates = 0;
  let correctedPixels = 0;
  let sceneGuardedPixels = 0;
  let continuationOverridePixels = 0;
  let artifactVetoPixels = 0;
  let curvedPixels = 0;
  let blendSum = 0;
  let agreementSum = 0;
  let localBeforeSum = 0;
  let localAfterSum = 0;
  let maxAppliedLumaDelta = 0;

  for (let y = 2; y < image.height - 2; y += 1) {
    for (let x = 2; x < image.width - 2; x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      const gradient = alphaGradient(alphaMap, image.width, image.height, x, y);
      const geometry = smoothstep(minGradient, fullGradient, gradient.magnitude);
      if (geometry < 0.10) continue;
      contourCandidates += 1;

      const prediction = tangentPrediction(image, alphaMap, safety, x, y, options);
      if (!prediction || prediction.agreement < minAgreement) continue;
      pairedCandidates += 1;

      const scene = sceneEdgeProtectionAt(image, safety.guardAlpha, x, y, options.sceneEdgeOptions || {});
      const strongContinuation = prediction.agreement >= strongAgreement;
      if (scene.weight >= hardSceneGuard && !strongContinuation) {
        sceneGuardedPixels += 1;
        continue;
      }
      if (scene.weight >= lineSceneGuard) {
        sceneGuardedPixels += 1;
        continue;
      }
      if (scene.weight >= hardSceneGuard && strongContinuation) continuationOverridePixels += 1;

      const currentRgb = rgbAt(image, x, y);
      const current = rgbToYcbcr(currentRgb);
      const target = rgbToYcbcr(prediction.target);
      const residual = target[0] - current[0];
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0) continue;

      const sceneAttenuation = scene.weight >= hardSceneGuard
        ? 0.42
        : clamp(1 - scene.weight * 1.10, 0.25, 1);
      const confidence = geometry * prediction.agreement * residualGate * sceneAttenuation;
      const blend = Math.min(maxBlend, strength * confidence);
      if (blend < 0.02) continue;

      const requestedDelta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const candidateY = current[0] + requestedDelta;
      const currentResidual = Math.abs(residual);
      const candidateResidual = Math.abs(target[0] - candidateY);
      if (candidateResidual + 0.02 >= currentResidual) {
        artifactVetoPixels += 1;
        continue;
      }

      const pairMin = Math.min(prediction.targetY, current[0]) - Number(options.localMargin ?? 7);
      const pairMax = Math.max(prediction.targetY, current[0]) + Number(options.localMargin ?? 7);
      if (candidateY < pairMin || candidateY > pairMax) {
        artifactVetoPixels += 1;
        continue;
      }

      const chromaBlend = Math.min(0.035, Math.max(0.006, blend * 0.08));
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
      if (Math.abs(prediction.angle) >= Math.PI / 20) curvedPixels += 1;
      blendSum += blend;
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
  const profile = continuationOverridePixels > 0
    ? 'line-crossing-continuation'
    : curvedPixels >= Math.max(2, Math.round(correctedPixels * 0.20))
      ? 'curved-texture-continuation'
      : 'tangent-contour-continuation';

  return {
    width: image.width,
    height: image.height,
    data,
    contourCandidates,
    pairedCandidates,
    correctedPixels,
    sceneGuardedPixels,
    continuationOverridePixels,
    artifactVetoPixels,
    curvedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanPairAgreement: correctedPixels ? agreementSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    maxAppliedLumaDelta,
    profile
  };
}

export function applyResidualStructureContinuationCore(image, alphaMap, options = {}) {
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineOptions(options));
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const minOutlineScore = Number.isFinite(options.minOutlineScore) ? options.minOutlineScore : 0.70;
  const minOutlineDensity = Number.isFinite(options.minOutlineDensity) ? options.minOutlineDensity : 0.035;
  const minOutlineSamples = Math.max(4, Math.round(Number(options.minOutlineSamples ?? 6)));
  const eligible = options.enabled !== false
    && beforeOutline.score >= minOutlineScore
    && beforeOutline.candidateDensity >= minOutlineDensity
    && beforeOutline.samples >= minOutlineSamples;

  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      residualStructureContinuationCore: {
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
  const outlineSafe = afterOutline.score <= beforeOutline.score * (options.maxOutlineRatio ?? 1.002) + 0.015;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.003 + 0.025
    && afterGlobal.luma <= beforeGlobal.luma * 1.004 + 0.035
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.004 + 0.20
    && optionalDeltaSafe(afterGlobal.darkCandidateMean, beforeGlobal.darkCandidateMean, 0.20)
    && optionalDeltaSafe(afterGlobal.darkCandidatePeak, beforeGlobal.darkCandidatePeak, 0.80)
    && optionalDeltaSafe(afterGlobal.clipFraction, beforeGlobal.clipFraction, 0.001);
  const artifactSafe = candidate.meanBlend <= maxMeanBlend + 1e-6
    && candidate.artifactVetoPixels <= Math.max(12, candidate.correctedPixels * 2.5 + 4);
  const accepted = candidate.correctedPixels >= minCorrectedPixels
    && candidate.localImprovement >= minLocalImprovement
    && outlineSafe
    && globalSafe
    && artifactSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? new Uint8ClampedArray(candidate.data) : new Uint8ClampedArray(image.data),
    residualStructureContinuationCore: {
      eligible,
      attempted: candidate.pairedCandidates > 0,
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
      contourCandidates: candidate.contourCandidates,
      pairedCandidates: candidate.pairedCandidates,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      continuationOverridePixels: candidate.continuationOverridePixels,
      curvedPixels: candidate.curvedPixels,
      artifactVetoPixels: candidate.artifactVetoPixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      meanPairAgreement: candidate.meanPairAgreement,
      localBeforeResidual: candidate.localBeforeResidual,
      localAfterResidual: candidate.localAfterResidual,
      localImprovement: candidate.localImprovement,
      maxAppliedLumaDelta: candidate.maxAppliedLumaDelta,
      outlineSafe,
      globalSafe,
      artifactSafe,
      minCorrectedPixels,
      minLocalImprovement,
      maxMeanBlend
    }
  };
}

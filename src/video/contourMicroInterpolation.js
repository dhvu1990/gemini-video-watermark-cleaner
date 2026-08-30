import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureGeometricOutlineResidual } from './protectedResidualRescue.js';
import { sceneEdgeProtectionAt } from './sceneEdgeProtection.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function rgbAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return [image.data[p], image.data[p + 1], image.data[p + 2]];
}
function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const p = y * width + x;
  const gx = ((alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0)) * 0.5;
  const gy = ((alphaMap[p + width] || 0) - (alphaMap[p - width] || 0)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function cleanAnchor(image, alphaMap, x, y, nx, ny, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.014;
  const start = Math.max(2, Math.round(Number(options.anchorStart ?? 2)));
  const maxRadius = Math.max(start + 1, Math.min(18, Math.round(Number(options.maxRadius ?? 12))));
  for (let d = start; d <= maxRadius; d++) {
    const xx = Math.round(x + nx * d * sign);
    const yy = Math.round(y + ny * d * sign);
    if (xx < 2 || yy < 2 || xx >= image.width - 2 || yy >= image.height - 2) break;
    if ((alphaMap[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance: d, x: xx, y: yy };
  }
  return null;
}

function contourPrediction(image, alphaMap, x, y, options = {}) {
  const gradient = alphaGradient(alphaMap, image.width, image.height, x, y);
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.006;
  if (gradient.magnitude < minGradient) return null;
  const nx = gradient.gx / gradient.magnitude;
  const ny = gradient.gy / gradient.magnitude;
  const negative = cleanAnchor(image, alphaMap, x, y, nx, ny, -1, options);
  const positive = cleanAnchor(image, alphaMap, x, y, nx, ny, 1, options);
  if (!negative || !positive) return null;
  const span = negative.distance + positive.distance;
  if (span <= 0) return null;
  const wn = positive.distance / span;
  const wp = negative.distance / span;
  const target = [0, 1, 2].map((c) => negative.rgb[c] * wn + positive.rgb[c] * wp);
  return {
    target,
    gradient: gradient.magnitude,
    endpointLumaDelta: Math.abs(luma(negative.rgb) - luma(positive.rgb)),
    span
  };
}

function outlineOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.minAlpha) ? options.minAlpha : 0.018,
    outlineMaxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.30,
    outlineResidualSoft: Number.isFinite(options.residualSoft) ? options.residualSoft : 0.55,
    outlineResidualHard: Number.isFinite(options.residualHard) ? options.residualHard : 3.8,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.62,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.018;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.28;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.40;
  const strength = clamp(Number(options.strength ?? 0.42), 0.12, 0.52);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.30), 0.10, 0.38);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 7), 3, 9);
  const endpointSoft = Number.isFinite(options.endpointSoft) ? options.endpointSoft : 7;
  const endpointHard = Number.isFinite(options.endpointHard) ? options.endpointHard : 22;
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.65;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 4.2;
  let correctedPixels = 0;
  let guardedPixels = 0;
  let missingAnchors = 0;
  let contourCandidates = 0;
  let blendSum = 0;
  let localBeforeResidualSum = 0;
  let localAfterResidualSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      const gradient = alphaGradient(alphaMap, image.width, image.height, x, y);
      const contourWeight = smoothstep(options.minAlphaGradient ?? 0.006, options.fullAlphaGradient ?? 0.055, gradient.magnitude);
      if (contourWeight < 0.08) continue;
      contourCandidates++;

      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        guardedPixels++;
        continue;
      }

      const prediction = contourPrediction(image, alphaMap, x, y, options);
      if (!prediction) {
        missingAnchors++;
        continue;
      }
      const endpointAgreement = 1 - smoothstep(endpointSoft, endpointHard, prediction.endpointLumaDelta);
      if (endpointAgreement <= 0.05) continue;

      const current = rgbAt(image, x, y);
      const currentY = luma(current);
      const targetY = luma(prediction.target);
      const residual = targetY - currentY;
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0) continue;
      const sceneWeight = clamp(1 - scene.weight * 1.18, 0, 1);
      const blend = Math.min(maxBlend, strength * contourWeight * endpointAgreement * residualGate * sceneWeight);
      if (blend < 0.025) continue;

      const delta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const idx = p * 4;
      const chromaBlend = Math.min(0.08, blend * 0.20);
      const next = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const lumaAdjusted = current[c] + delta;
        next[c] = clampByte(lumaAdjusted + (prediction.target[c] - lumaAdjusted) * chromaBlend);
        data[idx + c] = next[c];
      }
      correctedPixels++;
      blendSum += blend;
      localBeforeResidualSum += Math.abs(targetY - currentY);
      localAfterResidualSum += Math.abs(targetY - luma(next));
    }
  }

  const localBeforeResidual = correctedPixels ? localBeforeResidualSum / correctedPixels : 0;
  const localAfterResidual = correctedPixels ? localAfterResidualSum / correctedPixels : 0;
  const localImprovement = localBeforeResidual > 1e-9
    ? (localBeforeResidual - localAfterResidual) / localBeforeResidual
    : 0;
  const guardedFraction = contourCandidates ? guardedPixels / contourCandidates : 0;

  return {
    width: image.width,
    height: image.height,
    data,
    correctedPixels,
    guardedPixels,
    missingAnchors,
    contourCandidates,
    guardedFraction,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    hardSceneGuard,
    strength,
    maxBlend,
    maxLumaDelta
  };
}

export function applyContourMicroInterpolation(image, alphaMap, options = {}) {
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineOptions(options));
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1.10;
  const minDensity = Number.isFinite(options.minDensity) ? options.minDensity : 0.055;
  const minSamples = Math.max(8, Math.round(Number(options.minSamples ?? 10)));
  const minSectors = Math.max(2, Math.round(Number(options.minSectors ?? 2)));
  const eligible = options.enabled !== false
    && beforeOutline.score >= minScore
    && beforeOutline.candidateDensity >= minDensity
    && beforeOutline.samples >= minSamples
    && beforeOutline.sectorSupport >= minSectors;

  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      contourMicroInterpolation: {
        eligible,
        attempted: false,
        accepted: false,
        acceptanceMode: 'ineligible',
        beforeOutline,
        afterOutline: beforeOutline,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        correctedPixels: 0
      }
    };
  }

  const candidate = buildCandidate(image, alphaMap, options);
  const afterOutline = measureGeometricOutlineResidual(candidate, alphaMap, outlineOptions(options));
  const afterGlobal = measurePostCleanupResidual(candidate, alphaMap);
  const improvement = beforeOutline.score > 1e-9
    ? (beforeOutline.score - afterOutline.score) / beforeOutline.score
    : 0;
  const minCorrectedPixels = Math.max(4, Math.round(Number(options.minCorrectedPixels ?? 6)));
  const minImprovement = Number.isFinite(options.minImprovement) ? options.minImprovement : 0.003;
  const maxOutlineRatio = Number.isFinite(options.maxOutlineRatio) ? options.maxOutlineRatio : 0.997;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.28;
  const localMinImprovement = Number.isFinite(options.localMinImprovement) ? options.localMinImprovement : 0.10;
  const localMaxGuardedFraction = Number.isFinite(options.localMaxGuardedFraction) ? options.localMaxGuardedFraction : 0.72;
  const localMaxMeanBlend = Number.isFinite(options.localMaxMeanBlend) ? options.localMaxMeanBlend : 0.24;

  const enoughPixels = candidate.correctedPixels >= minCorrectedPixels;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.004 + 0.03
    && afterGlobal.luma <= beforeGlobal.luma * 1.005 + 0.03
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.004 + 0.25;
  const standardAccepted = enoughPixels
    && candidate.meanBlend <= maxMeanBlend
    && improvement >= minImprovement
    && afterOutline.score <= beforeOutline.score * maxOutlineRatio
    && globalSafe;
  const localBandAccepted = !standardAccepted
    && enoughPixels
    && candidate.meanBlend <= localMaxMeanBlend
    && candidate.localImprovement >= localMinImprovement
    && candidate.guardedFraction <= localMaxGuardedFraction
    && afterOutline.score <= beforeOutline.score
    && globalSafe;
  const accepted = standardAccepted || localBandAccepted;
  const acceptanceMode = standardAccepted ? 'outline-wide' : (localBandAccepted ? 'local-band' : 'rejected');

  return {
    width: image.width,
    height: image.height,
    data: accepted ? candidate.data : new Uint8ClampedArray(image.data),
    contourMicroInterpolation: {
      eligible,
      attempted: true,
      accepted,
      acceptanceMode,
      standardAccepted,
      localBandAccepted,
      globalSafe,
      beforeOutline,
      afterOutline: accepted ? afterOutline : beforeOutline,
      candidateAfterOutline: afterOutline,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      guardedPixels: candidate.guardedPixels,
      contourCandidates: candidate.contourCandidates,
      guardedFraction: candidate.guardedFraction,
      missingAnchors: candidate.missingAnchors,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      localBeforeResidual: candidate.localBeforeResidual,
      localAfterResidual: candidate.localAfterResidual,
      localImprovement: candidate.localImprovement,
      minCorrectedPixels,
      minImprovement,
      maxOutlineRatio,
      maxMeanBlend,
      localMinImprovement,
      localMaxGuardedFraction,
      localMaxMeanBlend,
      hardSceneGuard: candidate.hardSceneGuard,
      strength: candidate.strength,
      maxBlend: candidate.maxBlend,
      maxLumaDelta: candidate.maxLumaDelta
    }
  };
}

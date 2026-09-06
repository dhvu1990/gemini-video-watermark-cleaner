import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureGeometricOutlineResidual } from './protectedResidualRescue.js';
import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from './sceneEdgeProtection.js';

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
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const p = y * width + x;
  const gx = ((alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0)) * 0.5;
  const gy = ((alphaMap[p + width] || 0) - (alphaMap[p - width] || 0)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function confidencePolicy(options = {}) {
  const raw = Number(options.detectionConfidence);
  if (!Number.isFinite(raw)) {
    return { known: false, confidence: null, mode: 'unknown', enabled: true, strengthScale: 1, blendScale: 1 };
  }
  const confidence = clamp(raw, 0, 1);
  const lowCutoff = clamp(Number(options.lowConfidenceCutoff ?? 0.40), 0.05, 0.80);
  const mediumCutoff = clamp(Number(options.mediumConfidenceCutoff ?? 0.65), lowCutoff + 0.05, 0.95);
  if (confidence < lowCutoff) {
    return { known: true, confidence, mode: 'low', enabled: false, strengthScale: 0, blendScale: 0, lowCutoff, mediumCutoff };
  }
  if (confidence < mediumCutoff) {
    return { known: true, confidence, mode: 'medium', enabled: true, strengthScale: 0.62, blendScale: 0.68, lowCutoff, mediumCutoff };
  }
  return { known: true, confidence, mode: 'high', enabled: true, strengthScale: 1, blendScale: 1, lowCutoff, mediumCutoff };
}

function contourWeight(alphaMap, width, height, x, y, options = {}) {
  const p = y * width + x;
  const alpha = alphaMap[p] || 0;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.006;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.34;
  if (alpha < minAlpha || alpha > maxAlpha) return 0;
  const gradient = alphaGradient(alphaMap, width, height, x, y);
  const gradientWeight = smoothstep(options.gradientSoft ?? 0.006, options.gradientHard ?? 0.045, gradient.magnitude);
  const alphaIn = smoothstep(minAlpha, options.alphaPeakLow ?? 0.045, alpha);
  const alphaOut = 1 - smoothstep(options.alphaPeakHigh ?? 0.22, maxAlpha, alpha);
  return clamp(gradientWeight * (0.34 + 0.66 * alphaIn * alphaOut), 0, 1);
}

function cleanOutwardAnchor(image, alphaMap, x, y, nx, ny, tangentOffset, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const startRadius = Math.max(1, Math.round(Number(options.anchorStart ?? 2)));
  const maxRadius = Math.max(startRadius + 1, Math.min(18, Math.round(Number(options.maxRadius ?? 10))));
  const tx = -ny;
  const ty = nx;
  for (let d = startRadius; d <= maxRadius; d++) {
    const xx = Math.round(x - nx * d + tx * tangentOffset);
    const yy = Math.round(y - ny * d + ty * tangentOffset);
    if (xx < 2 || yy < 2 || xx >= image.width - 2 || yy >= image.height - 2) break;
    if ((alphaMap[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance: d, x: xx, y: yy };
  }
  return null;
}

function outwardPrediction(image, alphaMap, x, y, options = {}) {
  const gradient = alphaGradient(alphaMap, image.width, image.height, x, y);
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.0045;
  if (gradient.magnitude < minGradient) return null;
  const nx = gradient.gx / gradient.magnitude;
  const ny = gradient.gy / gradient.magnitude;
  const offsets = options.tangentOffsets || [-3, -1, 0, 1, 3];
  const anchors = offsets
    .map((offset) => cleanOutwardAnchor(image, alphaMap, x, y, nx, ny, offset, options))
    .filter(Boolean);
  const minAnchors = Math.max(2, Math.round(Number(options.minAnchors ?? 3)));
  if (anchors.length < minAnchors) return null;

  const target = [0, 1, 2].map((channel) => median(anchors.map((anchor) => anchor.rgb[channel])));
  const ys = anchors.map((anchor) => luma(anchor.rgb));
  return {
    target,
    anchors: anchors.length,
    spread: Math.max(...ys) - Math.min(...ys),
    meanDistance: anchors.reduce((sum, anchor) => sum + anchor.distance, 0) / anchors.length,
    gradient: gradient.magnitude
  };
}

function outlineMeasurementOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.minAlpha) ? options.minAlpha : 0.006,
    outlineMaxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.34,
    outlineResidualSoft: Number.isFinite(options.outlineResidualSoft) ? options.outlineResidualSoft : 0.45,
    outlineResidualHard: Number.isFinite(options.outlineResidualHard) ? options.outlineResidualHard : 3.2,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.70,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, policy, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const strength = clamp(Number(options.strength ?? 0.48) * policy.strengthScale, 0, 0.58);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.24) * policy.blendScale, 0, 0.30);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 7), 3, 9);
  const hardSceneGuard = policy.mode === 'medium'
    ? Math.min(Number(options.hardSceneGuard ?? 0.42), 0.34)
    : Number(options.hardSceneGuard ?? 0.42);
  const donorSpreadSoft = Number.isFinite(options.donorSpreadSoft) ? options.donorSpreadSoft : 5;
  const donorSpreadHard = Number.isFinite(options.donorSpreadHard) ? options.donorSpreadHard : 19;
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.55;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 3.8;
  let contourCandidates = 0;
  let correctedPixels = 0;
  let guardedPixels = 0;
  let missingAnchors = 0;
  let donorRejectedPixels = 0;
  let blendSum = 0;
  let localBeforeSum = 0;
  let localAfterSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const weight = contourWeight(alphaMap, image.width, image.height, x, y, options);
      if (weight < 0.08) continue;
      contourCandidates++;

      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        guardedPixels++;
        continue;
      }

      const prediction = outwardPrediction(image, alphaMap, x, y, options);
      if (!prediction) {
        missingAnchors++;
        continue;
      }
      const donorAgreement = 1 - smoothstep(donorSpreadSoft, donorSpreadHard, prediction.spread);
      if (donorAgreement <= 0.06) {
        donorRejectedPixels++;
        continue;
      }

      const current = rgbAt(image, x, y);
      const currentY = luma(current);
      const targetY = luma(prediction.target);
      const residual = targetY - currentY;
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0.02) continue;
      const sceneAttenuation = clamp(1 - scene.weight * 1.42, 0, 1);
      const blend = Math.min(maxBlend, strength * weight * donorAgreement * residualGate * sceneAttenuation);
      if (blend < 0.025) continue;

      const idx = (y * image.width + x) * 4;
      const lumaDelta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const chromaBlend = Math.min(0.07, blend * 0.18);
      const next = [0, 0, 0];
      for (let channel = 0; channel < 3; channel++) {
        const adjusted = current[channel] + lumaDelta;
        next[channel] = clampByte(adjusted + (prediction.target[channel] - adjusted) * chromaBlend);
        data[idx + channel] = next[channel];
      }
      correctedPixels++;
      blendSum += blend;
      localBeforeSum += Math.abs(residual);
      localAfterSum += Math.abs(targetY - luma(next));
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
    contourCandidates,
    correctedPixels,
    guardedPixels,
    guardedFraction: contourCandidates ? guardedPixels / contourCandidates : 0,
    missingAnchors,
    donorRejectedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    strength,
    maxBlend,
    maxLumaDelta,
    hardSceneGuard
  };
}

function assessCandidate(candidate, alphaMap, beforeOutline, beforeGlobal, options = {}) {
  const afterOutline = measureGeometricOutlineResidual(candidate, alphaMap, outlineMeasurementOptions(options));
  const afterGlobal = measurePostCleanupResidual(candidate, alphaMap);
  const outlineImprovement = beforeOutline.score > 1e-9
    ? (beforeOutline.score - afterOutline.score) / beforeOutline.score
    : 0;
  const minCorrectedPixels = Math.max(3, Math.round(Number(options.minCorrectedPixels ?? 4)));
  const minOutlineImprovement = Number.isFinite(options.minOutlineImprovement) ? options.minOutlineImprovement : 0.012;
  const maxOutlineRatio = Number.isFinite(options.maxOutlineRatio) ? options.maxOutlineRatio : 0.990;
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.08;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.23;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.012 + 0.05
    && afterGlobal.luma <= beforeGlobal.luma * 1.015 + 0.05
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.010 + 0.35;
  const localContourAccepted = candidate.correctedPixels >= minCorrectedPixels
    && candidate.meanBlend <= maxMeanBlend
    && candidate.localImprovement >= minLocalImprovement
    && outlineImprovement >= minOutlineImprovement
    && afterOutline.score <= beforeOutline.score * maxOutlineRatio
    && globalSafe;
  return {
    accepted: localContourAccepted,
    localContourAccepted,
    globalSafe,
    afterOutline,
    afterGlobal,
    outlineImprovement,
    minCorrectedPixels,
    minOutlineImprovement,
    maxOutlineRatio,
    minLocalImprovement,
    maxMeanBlend
  };
}

export function applyPersistentContourSilhouetteDissolve(image, alphaMap, options = {}) {
  const policy = confidencePolicy(options);
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineMeasurementOptions(options));
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const sceneRisk = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.88;
  const minDensity = Number.isFinite(options.minDensity) ? options.minDensity : 0.040;
  const minSamples = Math.max(6, Math.round(Number(options.minSamples ?? 8)));
  const minSectors = Math.max(2, Math.round(Number(options.minSectors ?? 2)));
  const outlineStrong = beforeOutline.score >= minScore
    && beforeOutline.candidateDensity >= minDensity
    && beforeOutline.samples >= minSamples
    && beforeOutline.sectorSupport >= minSectors;
  const eligible = options.enabled !== false && policy.enabled && outlineStrong;

  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      persistentContourSilhouetteDissolve: {
        enabled: options.enabled !== false,
        eligible,
        attempted: false,
        accepted: false,
        reason: !policy.enabled ? 'low-detection-confidence' : (outlineStrong ? 'disabled' : 'outline-not-strong'),
        confidencePolicy: policy,
        sceneRisk,
        beforeOutline,
        afterOutline: beforeOutline,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        correctedPixels: 0,
        passesAttempted: 0,
        passesAccepted: 0,
        remainingStrong: outlineStrong
      }
    };
  }

  const maxPasses = Math.max(1, Math.min(2, Math.round(Number(options.maxPasses ?? 2))));
  let selected = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  let currentOutline = beforeOutline;
  let currentGlobal = beforeGlobal;
  let finalCandidate = null;
  let finalAssessment = null;
  let passesAttempted = 0;
  let passesAccepted = 0;
  let totalCorrectedPixels = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const passOptions = pass === 0 ? options : {
      ...options,
      strength: Number(options.strength ?? 0.48) * 0.82,
      maxBlend: Number(options.maxBlend ?? 0.24) * 0.88
    };
    const candidate = buildCandidate(selected, alphaMap, policy, passOptions);
    const assessment = assessCandidate(candidate, alphaMap, currentOutline, currentGlobal, passOptions);
    passesAttempted++;
    finalCandidate = candidate;
    finalAssessment = assessment;
    if (!assessment.accepted) break;
    selected = { width: candidate.width, height: candidate.height, data: new Uint8ClampedArray(candidate.data) };
    currentOutline = assessment.afterOutline;
    currentGlobal = assessment.afterGlobal;
    totalCorrectedPixels += candidate.correctedPixels;
    passesAccepted++;
    if (currentOutline.score < minScore * 0.78 || currentOutline.candidateDensity < minDensity * 0.72) break;
  }

  const accepted = passesAccepted > 0;
  const afterOutline = accepted ? currentOutline : beforeOutline;
  const afterGlobal = accepted ? currentGlobal : beforeGlobal;
  const remainingStrong = afterOutline.score >= minScore
    && afterOutline.candidateDensity >= minDensity
    && afterOutline.samples >= minSamples
    && afterOutline.sectorSupport >= minSectors;
  return {
    width: image.width,
    height: image.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    persistentContourSilhouetteDissolve: {
      enabled: options.enabled !== false,
      eligible,
      attempted: true,
      accepted,
      reason: accepted ? 'local-contour-improvement' : 'candidate-rejected',
      acceptanceMode: accepted ? 'local-contour-metric' : 'rejected',
      confidencePolicy: policy,
      sceneRisk,
      beforeOutline,
      afterOutline,
      candidateAfterOutline: finalAssessment?.afterOutline || beforeOutline,
      outlineImprovement: beforeOutline.score > 1e-9 ? (beforeOutline.score - afterOutline.score) / beforeOutline.score : 0,
      candidateOutlineImprovement: finalAssessment?.outlineImprovement || 0,
      beforeGlobal,
      afterGlobal,
      candidateAfterGlobal: finalAssessment?.afterGlobal || beforeGlobal,
      globalSafe: finalAssessment?.globalSafe ?? true,
      correctedPixels: accepted ? totalCorrectedPixels : 0,
      candidateCorrectedPixels: finalCandidate?.correctedPixels || 0,
      contourCandidates: finalCandidate?.contourCandidates || 0,
      guardedPixels: finalCandidate?.guardedPixels || 0,
      guardedFraction: finalCandidate?.guardedFraction || 0,
      missingAnchors: finalCandidate?.missingAnchors || 0,
      donorRejectedPixels: finalCandidate?.donorRejectedPixels || 0,
      meanBlend: accepted ? (finalCandidate?.meanBlend || 0) : 0,
      candidateMeanBlend: finalCandidate?.meanBlend || 0,
      localBeforeResidual: finalCandidate?.localBeforeResidual || 0,
      localAfterResidual: finalCandidate?.localAfterResidual || 0,
      localImprovement: finalCandidate?.localImprovement || 0,
      minCorrectedPixels: finalAssessment?.minCorrectedPixels ?? Math.max(3, Math.round(Number(options.minCorrectedPixels ?? 4))),
      minOutlineImprovement: finalAssessment?.minOutlineImprovement ?? Number(options.minOutlineImprovement ?? 0.012),
      maxOutlineRatio: finalAssessment?.maxOutlineRatio ?? Number(options.maxOutlineRatio ?? 0.990),
      minLocalImprovement: finalAssessment?.minLocalImprovement ?? Number(options.minLocalImprovement ?? 0.08),
      maxMeanBlend: finalAssessment?.maxMeanBlend ?? Number(options.maxMeanBlend ?? 0.23),
      passesAttempted,
      passesAccepted,
      maxPasses,
      remainingStrong
    }
  };
}

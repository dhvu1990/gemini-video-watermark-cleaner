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
function lumaAt(image, x, y) { return luma(rgbAt(image, x, y)); }
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

function imageGradient(image, x, y) {
  if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const gx = (lumaAt(image, x + 1, y) - lumaAt(image, x - 1, y)) * 0.5;
  const gy = (lumaAt(image, x, y + 1) - lumaAt(image, x, y - 1)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function gradientSample(image, x, y) {
  const xx = Math.round(x);
  const yy = Math.round(y);
  if (xx < 1 || yy < 1 || xx >= image.width - 1 || yy >= image.height - 1) return null;
  return imageGradient(image, xx, yy);
}

function directionalSimilarity(a, b) {
  if (!b || a.magnitude < 1e-6 || b.magnitude < 1e-6) return 0;
  const dot = Math.abs((a.gx * b.gx + a.gy * b.gy) / (a.magnitude * b.magnitude));
  const strengthRatio = Math.min(a.magnitude, b.magnitude) / Math.max(a.magnitude, b.magnitude);
  return dot * smoothstep(0.20, 0.70, strengthRatio);
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

function directContourDescriptor(alphaMap, width, height, x, y, options = {}) {
  const weight = contourWeight(alphaMap, width, height, x, y, options);
  if (weight <= 0) return null;
  const gradient = alphaGradient(alphaMap, width, height, x, y);
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.0045;
  if (gradient.magnitude < minGradient) return null;
  return {
    weight,
    nx: gradient.gx / gradient.magnitude,
    ny: gradient.gy / gradient.magnitude,
    gradient: gradient.magnitude,
    exterior: false,
    distance: 0,
    seedX: x,
    seedY: y,
    alignment: 1
  };
}

function effectiveOuterBandRadius(policy, options = {}) {
  let radius = Math.max(0, Math.min(4, Math.round(Number(options.outerBandRadius ?? 3))));
  if (policy.mode === 'medium') radius = Math.min(radius, 1);
  return radius;
}

function exteriorContourDescriptor(alphaMap, width, height, x, y, policy, options = {}) {
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.006;
  if ((alphaMap[y * width + x] || 0) >= minAlpha) return null;
  const radius = effectiveOuterBandRadius(policy, options);
  if (radius < 1) return null;

  const minAlignment = clamp(Number(options.outerBandMinAlignment ?? 0.50), 0.20, 0.95);
  const scale = clamp(Number(options.outerBandScale ?? (policy.mode === 'medium' ? 0.34 : 0.78)), 0, 1);
  let best = null;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const distance = Math.hypot(dx, dy);
      if (distance > radius + 0.05) continue;
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 2 || sy < 2 || sx >= width - 2 || sy >= height - 2) continue;
      const seed = directContourDescriptor(alphaMap, width, height, sx, sy, options);
      if (!seed) continue;
      const outwardX = -seed.nx;
      const outwardY = -seed.ny;
      const alignment = (dx * outwardX + dy * outwardY) / Math.max(distance, 1e-6);
      if (alignment < minAlignment) continue;
      const distanceWeight = 1 - smoothstep(0.35, radius + 0.45, distance);
      const weight = seed.weight * scale * alignment * distanceWeight;
      if (weight < 0.035) continue;
      if (!best || weight > best.weight) {
        best = {
          weight,
          nx: seed.nx,
          ny: seed.ny,
          gradient: seed.gradient,
          exterior: true,
          distance,
          bandRadius: radius,
          seedX: sx,
          seedY: sy,
          alignment
        };
      }
    }
  }
  return best;
}

function contourDescriptor(alphaMap, width, height, x, y, policy, options = {}) {
  return directContourDescriptor(alphaMap, width, height, x, y, options)
    || exteriorContourDescriptor(alphaMap, width, height, x, y, policy, options);
}

function exteriorSceneRiskAt(image, descriptor, x, y, options = {}) {
  if (!descriptor?.exterior) return 0;
  const edge = imageGradient(image, x, y);
  const soft = Number.isFinite(options.exteriorSceneGradientSoft) ? options.exteriorSceneGradientSoft : 4.5;
  const hard = Number.isFinite(options.exteriorSceneGradientHard) ? options.exteriorSceneGradientHard : 12.0;
  if (edge.magnitude < soft) return 0;
  const shapeAlignment = Math.abs((edge.gx * descriptor.nx + edge.gy * descriptor.ny) / Math.max(edge.magnitude, 1e-6));
  const nonShapeOrientation = 1 - smoothstep(0.52, 0.86, shapeAlignment);
  const strength = smoothstep(soft, hard, edge.magnitude);
  const tx = -edge.gy / Math.max(edge.magnitude, 1e-6);
  const ty = edge.gx / Math.max(edge.magnitude, 1e-6);
  const distance = Math.max(2, Math.min(4, Number(options.exteriorSceneContinuityDistance ?? 3)));
  const positive = gradientSample(image, x + tx * distance, y + ty * distance);
  const negative = gradientSample(image, x - tx * distance, y - ty * distance);
  const continuity = Math.max(directionalSimilarity(edge, positive), directionalSimilarity(edge, negative));
  const continuityBoost = 0.64 + 0.36 * smoothstep(0.30, 0.78, continuity);
  return clamp(strength * nonShapeOrientation * continuityBoost, 0, 1);
}

function cleanOutwardAnchor(image, alphaMap, x, y, nx, ny, tangentOffset, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const startRadius = Math.max(1, Math.round(Number(options.anchorStart ?? 2)));
  const maxRadius = Math.max(startRadius + 1, Math.min(20, Math.round(Number(options.maxRadius ?? 12))));
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

function outwardPrediction(image, alphaMap, x, y, options = {}, descriptor = null) {
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.0045;
  let nx;
  let ny;
  let gradientMagnitude;
  if (descriptor && descriptor.gradient >= minGradient) {
    nx = descriptor.nx;
    ny = descriptor.ny;
    gradientMagnitude = descriptor.gradient;
  } else {
    const gradient = alphaGradient(alphaMap, image.width, image.height, x, y);
    if (gradient.magnitude < minGradient) return null;
    nx = gradient.gx / gradient.magnitude;
    ny = gradient.gy / gradient.magnitude;
    gradientMagnitude = gradient.magnitude;
  }
  const offsets = options.tangentOffsets || [-3, -1, 0, 1, 3];
  const anchorOptions = descriptor?.exterior
    ? {
        ...options,
        anchorStart: Math.max(
          Math.round(Number(options.anchorStart ?? 2)),
          Math.ceil(Number(descriptor.bandRadius ?? descriptor.distance ?? 0)) + 2
        )
      }
    : options;
  const anchors = offsets
    .map((offset) => cleanOutwardAnchor(image, alphaMap, x, y, nx, ny, offset, anchorOptions))
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
    gradient: gradientMagnitude
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
  const highConfidence = policy.mode === 'high';
  const strengthBoost = highConfidence ? clamp(Number(options.highConfidenceStrengthBoost ?? 1.12), 1, 1.35) : 1;
  const blendBoost = highConfidence ? clamp(Number(options.highConfidenceBlendBoost ?? 1.22), 1, 1.45) : 1;
  const strength = clamp(Number(options.strength ?? 0.48) * policy.strengthScale * strengthBoost, 0, 0.66);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.24) * policy.blendScale * blendBoost, 0, 0.36);
  const lumaBoost = highConfidence ? clamp(Number(options.highConfidenceLumaBoost ?? 2), 0, 3) : 0;
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 7) + lumaBoost, 3, 11);
  const hardSceneGuard = policy.mode === 'medium'
    ? Math.min(Number(options.hardSceneGuard ?? 0.42), 0.34)
    : Number(options.hardSceneGuard ?? 0.42);
  const donorSpreadSoft = Number.isFinite(options.donorSpreadSoft) ? options.donorSpreadSoft : 5;
  const donorSpreadHard = Number.isFinite(options.donorSpreadHard) ? options.donorSpreadHard : 19;
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.45;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 3.4;
  let contourCandidates = 0;
  let exteriorCandidates = 0;
  let correctedPixels = 0;
  let exteriorCorrectedPixels = 0;
  let guardedPixels = 0;
  let exteriorGuardedPixels = 0;
  let missingAnchors = 0;
  let donorRejectedPixels = 0;
  let maxExteriorDistance = 0;
  let blendSum = 0;
  let localBeforeSum = 0;
  let localAfterSum = 0;
  let exteriorBeforeSum = 0;
  let exteriorAfterSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const descriptor = contourDescriptor(alphaMap, image.width, image.height, x, y, policy, options);
      if (!descriptor || descriptor.weight < 0.035) continue;
      contourCandidates++;
      if (descriptor.exterior) {
        exteriorCandidates++;
        maxExteriorDistance = Math.max(maxExteriorDistance, descriptor.distance);
      }

      const scene = sceneEdgeProtectionAt(
        image,
        alphaMap,
        descriptor.exterior ? descriptor.seedX : x,
        descriptor.exterior ? descriptor.seedY : y,
        options.sceneEdgeOptions || {}
      );
      const exteriorSceneRisk = descriptor.exterior ? exteriorSceneRiskAt(image, descriptor, x, y, options) : 0;
      const sceneWeight = Math.max(scene.weight, exteriorSceneRisk);
      if (sceneWeight >= hardSceneGuard) {
        guardedPixels++;
        if (descriptor.exterior) exteriorGuardedPixels++;
        continue;
      }

      const prediction = outwardPrediction(image, alphaMap, x, y, options, descriptor);
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
      const sceneAttenuation = clamp(1 - sceneWeight * 1.42, 0, 1);
      const blend = Math.min(maxBlend, strength * descriptor.weight * donorAgreement * residualGate * sceneAttenuation);
      const minBlend = descriptor.exterior ? 0.016 : 0.025;
      if (blend < minBlend) continue;

      const idx = (y * image.width + x) * 4;
      const lumaDelta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const chromaBlend = Math.min(highConfidence ? 0.10 : 0.07, blend * (descriptor.exterior ? 0.26 : 0.20));
      const next = [0, 0, 0];
      for (let channel = 0; channel < 3; channel++) {
        const adjusted = current[channel] + lumaDelta;
        next[channel] = clampByte(adjusted + (prediction.target[channel] - adjusted) * chromaBlend);
        data[idx + channel] = next[channel];
      }
      correctedPixels++;
      if (descriptor.exterior) exteriorCorrectedPixels++;
      blendSum += blend;
      const beforeResidual = Math.abs(residual);
      const afterResidual = Math.abs(targetY - luma(next));
      localBeforeSum += beforeResidual;
      localAfterSum += afterResidual;
      if (descriptor.exterior) {
        exteriorBeforeSum += beforeResidual;
        exteriorAfterSum += afterResidual;
      }
    }
  }

  const localBeforeResidual = correctedPixels ? localBeforeSum / correctedPixels : 0;
  const localAfterResidual = correctedPixels ? localAfterSum / correctedPixels : 0;
  const localImprovement = localBeforeResidual > 1e-9
    ? (localBeforeResidual - localAfterResidual) / localBeforeResidual
    : 0;
  const exteriorBeforeResidual = exteriorCorrectedPixels ? exteriorBeforeSum / exteriorCorrectedPixels : 0;
  const exteriorAfterResidual = exteriorCorrectedPixels ? exteriorAfterSum / exteriorCorrectedPixels : 0;
  const exteriorLocalImprovement = exteriorBeforeResidual > 1e-9
    ? (exteriorBeforeResidual - exteriorAfterResidual) / exteriorBeforeResidual
    : 0;
  return {
    width: image.width,
    height: image.height,
    data,
    contourCandidates,
    exteriorCandidates,
    correctedPixels,
    exteriorCorrectedPixels,
    guardedPixels,
    exteriorGuardedPixels,
    guardedFraction: contourCandidates ? guardedPixels / contourCandidates : 0,
    missingAnchors,
    donorRejectedPixels,
    maxExteriorDistance,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    exteriorBeforeResidual,
    exteriorAfterResidual,
    exteriorLocalImprovement,
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
  const minOutlineImprovement = Number.isFinite(options.minOutlineImprovement) ? options.minOutlineImprovement : 0.010;
  const maxOutlineRatio = Number.isFinite(options.maxOutlineRatio) ? options.maxOutlineRatio : 0.992;
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.07;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.28;
  const minExteriorCorrectedPixels = Math.max(2, Math.round(Number(options.minExteriorCorrectedPixels ?? 3)));
  const minExteriorLocalImprovement = Number.isFinite(options.minExteriorLocalImprovement) ? options.minExteriorLocalImprovement : 0.07;
  const maxExteriorOutlineRatio = Number.isFinite(options.maxExteriorOutlineRatio) ? options.maxExteriorOutlineRatio : 1.006;
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.012 + 0.05
    && afterGlobal.luma <= beforeGlobal.luma * 1.015 + 0.05
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.010 + 0.35;
  const exteriorGlobalSafe = afterGlobal.total <= beforeGlobal.total * 1.040 + 0.12
    && afterGlobal.luma <= beforeGlobal.luma * 1.045 + 0.15
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.030 + 0.50;
  const localContourAccepted = candidate.correctedPixels >= minCorrectedPixels
    && candidate.meanBlend <= maxMeanBlend
    && candidate.localImprovement >= minLocalImprovement
    && outlineImprovement >= minOutlineImprovement
    && afterOutline.score <= beforeOutline.score * maxOutlineRatio
    && globalSafe;
  const exteriorOutlineSafe = afterOutline.score <= beforeOutline.score * maxExteriorOutlineRatio + 0.02;
  const exteriorContourAccepted = candidate.exteriorCorrectedPixels >= minExteriorCorrectedPixels
    && candidate.meanBlend <= maxMeanBlend
    && candidate.exteriorLocalImprovement >= minExteriorLocalImprovement
    && exteriorOutlineSafe
    && exteriorGlobalSafe;
  return {
    accepted: localContourAccepted || exteriorContourAccepted,
    localContourAccepted,
    exteriorContourAccepted,
    exteriorOutlineSafe,
    globalSafe,
    exteriorGlobalSafe,
    afterOutline,
    afterGlobal,
    outlineImprovement,
    minCorrectedPixels,
    minOutlineImprovement,
    maxOutlineRatio,
    minLocalImprovement,
    maxMeanBlend,
    minExteriorCorrectedPixels,
    minExteriorLocalImprovement,
    maxExteriorOutlineRatio
  };
}

// v1.0.126: the normal acceptance gate intentionally stays strict. When it rejects
// a candidate on a genuinely smooth/low-scene-risk ROI, allow a second local-only
// decision based on contour improvement. This targets the real-world failure mode
// where the diamond silhouette is visibly reduced locally but the aggregate ROI
// metric moves by a few hundredths and rolls the whole candidate back.
function assessSmoothSceneFallback(candidate, assessment, beforeOutline, beforeGlobal, sceneRisk, policy, options = {}) {
  const enabled = options.smoothSceneFallback !== false && policy.mode === 'high';
  const maxSceneScore = Number.isFinite(options.smoothFallbackMaxSceneScore) ? options.smoothFallbackMaxSceneScore : 0.18;
  const maxSceneDensity = Number.isFinite(options.smoothFallbackMaxSceneDensity) ? options.smoothFallbackMaxSceneDensity : 0.035;
  const maxContinuityDensity = Number.isFinite(options.smoothFallbackMaxContinuityDensity) ? options.smoothFallbackMaxContinuityDensity : 0.020;
  const sceneSafe = !sceneRisk?.protect
    && sceneRisk?.level !== 'high'
    && (Number(sceneRisk?.score) || 0) <= maxSceneScore
    && (Number(sceneRisk?.density) || 0) <= maxSceneDensity
    && (Number(sceneRisk?.continuityDensity) || 0) <= maxContinuityDensity;

  const minCorrectedPixels = Math.max(4, Math.round(Number(options.smoothFallbackMinCorrectedPixels ?? 5)));
  const minExteriorCorrectedPixels = Math.max(2, Math.round(Number(options.smoothFallbackMinExteriorCorrectedPixels ?? 3)));
  const minLocalImprovement = Number.isFinite(options.smoothFallbackMinLocalImprovement) ? options.smoothFallbackMinLocalImprovement : 0.045;
  const minExteriorLocalImprovement = Number.isFinite(options.smoothFallbackMinExteriorLocalImprovement) ? options.smoothFallbackMinExteriorLocalImprovement : 0.045;
  const maxMeanBlend = Number.isFinite(options.smoothFallbackMaxMeanBlend) ? options.smoothFallbackMaxMeanBlend : 0.30;
  const maxOutlineRatio = Number.isFinite(options.smoothFallbackMaxOutlineRatio) ? options.smoothFallbackMaxOutlineRatio : 1.015;
  const maxTotalRatio = Number.isFinite(options.smoothFallbackMaxTotalRatio) ? options.smoothFallbackMaxTotalRatio : 1.035;
  const maxLumaRatio = Number.isFinite(options.smoothFallbackMaxLumaRatio) ? options.smoothFallbackMaxLumaRatio : 1.040;
  const maxChromaRatio = Number.isFinite(options.smoothFallbackMaxChromaRatio) ? options.smoothFallbackMaxChromaRatio : 1.030;

  const localEvidence = candidate.correctedPixels >= minCorrectedPixels
    && candidate.localImprovement >= minLocalImprovement;
  const exteriorEvidence = candidate.exteriorCorrectedPixels >= minExteriorCorrectedPixels
    && candidate.exteriorLocalImprovement >= minExteriorLocalImprovement;
  const blendSafe = candidate.meanBlend <= maxMeanBlend;
  const outlineSafe = assessment.afterOutline.score <= beforeOutline.score * maxOutlineRatio + 0.03;
  const aggregateSafe = assessment.afterGlobal.total <= beforeGlobal.total * maxTotalRatio + 0.10
    && assessment.afterGlobal.luma <= beforeGlobal.luma * maxLumaRatio + 0.12
    && assessment.afterGlobal.chroma <= beforeGlobal.chroma * maxChromaRatio + 0.45;
  const accepted = enabled && sceneSafe && blendSafe && outlineSafe && aggregateSafe && (localEvidence || exteriorEvidence);

  return {
    enabled,
    attempted: enabled && !assessment.accepted,
    accepted,
    sceneSafe,
    localEvidence,
    exteriorEvidence,
    blendSafe,
    outlineSafe,
    aggregateSafe,
    maxSceneScore,
    maxSceneDensity,
    maxContinuityDensity,
    minCorrectedPixels,
    minExteriorCorrectedPixels,
    minLocalImprovement,
    minExteriorLocalImprovement,
    maxMeanBlend,
    maxOutlineRatio,
    maxTotalRatio,
    maxLumaRatio,
    maxChromaRatio
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
        globalSafe: true,
        exteriorGlobalSafe: true,
        smoothSceneFallback: { enabled: options.smoothSceneFallback !== false && policy.mode === 'high', attempted: false, accepted: false },
        correctedPixels: 0,
        exteriorCorrectedPixels: 0,
        maxExteriorDistance: 0,
        candidateMaxExteriorDistance: 0,
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
  let finalFallback = null;
  let lastAcceptedCandidate = null;
  let lastAcceptedAssessment = null;
  let lastAcceptedFallback = null;
  let passesAttempted = 0;
  let passesAccepted = 0;
  let fallbackPassesAccepted = 0;
  let totalCorrectedPixels = 0;
  let totalExteriorCorrectedPixels = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const passOptions = pass === 0 ? options : {
      ...options,
      strength: Number(options.strength ?? 0.48) * 0.84,
      maxBlend: Number(options.maxBlend ?? 0.24) * 0.90,
      outerBandScale: Number(options.outerBandScale ?? (policy.mode === 'medium' ? 0.34 : 0.78)) * 0.88
    };
    const candidate = buildCandidate(selected, alphaMap, policy, passOptions);
    const assessment = assessCandidate(candidate, alphaMap, currentOutline, currentGlobal, passOptions);
    const fallback = assessment.accepted
      ? { enabled: options.smoothSceneFallback !== false && policy.mode === 'high', attempted: false, accepted: false }
      : assessSmoothSceneFallback(candidate, assessment, currentOutline, currentGlobal, sceneRisk, policy, passOptions);
    const passAccepted = assessment.accepted || fallback.accepted;
    passesAttempted++;
    finalCandidate = candidate;
    finalAssessment = assessment;
    finalFallback = fallback;
    if (!passAccepted) break;
    selected = { width: candidate.width, height: candidate.height, data: new Uint8ClampedArray(candidate.data) };
    currentOutline = assessment.afterOutline;
    currentGlobal = assessment.afterGlobal;
    totalCorrectedPixels += candidate.correctedPixels;
    totalExteriorCorrectedPixels += candidate.exteriorCorrectedPixels;
    lastAcceptedCandidate = candidate;
    lastAcceptedAssessment = assessment;
    lastAcceptedFallback = fallback;
    passesAccepted++;
    if (fallback.accepted) fallbackPassesAccepted++;
    if (currentOutline.score < minScore * 0.78 || currentOutline.candidateDensity < minDensity * 0.72) break;
  }

  const accepted = passesAccepted > 0;
  const effectiveCandidate = accepted ? lastAcceptedCandidate : finalCandidate;
  const effectiveAssessment = accepted ? lastAcceptedAssessment : finalAssessment;
  const effectiveFallback = accepted ? lastAcceptedFallback : finalFallback;
  const afterOutline = accepted ? currentOutline : beforeOutline;
  const afterGlobal = accepted ? currentGlobal : beforeGlobal;
  const remainingStrong = afterOutline.score >= minScore
    && afterOutline.candidateDensity >= minDensity
    && afterOutline.samples >= minSamples
    && afterOutline.sectorSupport >= minSectors;
  const acceptanceMode = accepted
    ? (effectiveFallback?.accepted
      ? 'smooth-scene-local-fallback'
      : (effectiveAssessment?.localContourAccepted
        ? 'local-contour-metric'
        : (effectiveAssessment?.exteriorContourAccepted ? 'exterior-contour-metric' : 'accepted')))
    : 'rejected';
  return {
    width: image.width,
    height: image.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    persistentContourSilhouetteDissolve: {
      enabled: options.enabled !== false,
      eligible,
      attempted: true,
      accepted,
      reason: accepted ? 'contour-halo-improvement' : 'candidate-rejected',
      acceptanceMode,
      confidencePolicy: policy,
      sceneRisk,
      beforeOutline,
      afterOutline,
      candidateAfterOutline: effectiveAssessment?.afterOutline || beforeOutline,
      outlineImprovement: beforeOutline.score > 1e-9 ? (beforeOutline.score - afterOutline.score) / beforeOutline.score : 0,
      candidateOutlineImprovement: effectiveAssessment?.outlineImprovement || 0,
      beforeGlobal,
      afterGlobal,
      candidateAfterGlobal: effectiveAssessment?.afterGlobal || beforeGlobal,
      globalSafe: effectiveAssessment?.globalSafe ?? true,
      exteriorGlobalSafe: effectiveAssessment?.exteriorGlobalSafe ?? true,
      smoothSceneFallback: effectiveFallback || { enabled: options.smoothSceneFallback !== false && policy.mode === 'high', attempted: false, accepted: false },
      correctedPixels: accepted ? totalCorrectedPixels : 0,
      exteriorCorrectedPixels: accepted ? totalExteriorCorrectedPixels : 0,
      candidateCorrectedPixels: effectiveCandidate?.correctedPixels || 0,
      candidateExteriorCorrectedPixels: effectiveCandidate?.exteriorCorrectedPixels || 0,
      contourCandidates: effectiveCandidate?.contourCandidates || 0,
      exteriorCandidates: effectiveCandidate?.exteriorCandidates || 0,
      maxExteriorDistance: accepted ? (effectiveCandidate?.maxExteriorDistance || 0) : 0,
      candidateMaxExteriorDistance: effectiveCandidate?.maxExteriorDistance || 0,
      guardedPixels: effectiveCandidate?.guardedPixels || 0,
      exteriorGuardedPixels: effectiveCandidate?.exteriorGuardedPixels || 0,
      guardedFraction: effectiveCandidate?.guardedFraction || 0,
      missingAnchors: effectiveCandidate?.missingAnchors || 0,
      donorRejectedPixels: effectiveCandidate?.donorRejectedPixels || 0,
      meanBlend: accepted ? (effectiveCandidate?.meanBlend || 0) : 0,
      candidateMeanBlend: effectiveCandidate?.meanBlend || 0,
      localBeforeResidual: effectiveCandidate?.localBeforeResidual || 0,
      localAfterResidual: effectiveCandidate?.localAfterResidual || 0,
      localImprovement: effectiveCandidate?.localImprovement || 0,
      exteriorBeforeResidual: effectiveCandidate?.exteriorBeforeResidual || 0,
      exteriorAfterResidual: effectiveCandidate?.exteriorAfterResidual || 0,
      exteriorLocalImprovement: effectiveCandidate?.exteriorLocalImprovement || 0,
      minCorrectedPixels: effectiveAssessment?.minCorrectedPixels ?? Math.max(3, Math.round(Number(options.minCorrectedPixels ?? 4))),
      minOutlineImprovement: effectiveAssessment?.minOutlineImprovement ?? Number(options.minOutlineImprovement ?? 0.010),
      maxOutlineRatio: effectiveAssessment?.maxOutlineRatio ?? Number(options.maxOutlineRatio ?? 0.992),
      minLocalImprovement: effectiveAssessment?.minLocalImprovement ?? Number(options.minLocalImprovement ?? 0.07),
      maxMeanBlend: effectiveAssessment?.maxMeanBlend ?? Number(options.maxMeanBlend ?? 0.28),
      minExteriorCorrectedPixels: effectiveAssessment?.minExteriorCorrectedPixels ?? Math.max(2, Math.round(Number(options.minExteriorCorrectedPixels ?? 3))),
      minExteriorLocalImprovement: effectiveAssessment?.minExteriorLocalImprovement ?? Number(options.minExteriorLocalImprovement ?? 0.07),
      maxExteriorOutlineRatio: effectiveAssessment?.maxExteriorOutlineRatio ?? Number(options.maxExteriorOutlineRatio ?? 1.006),
      passesAttempted,
      passesAccepted,
      fallbackPassesAccepted,
      maxPasses,
      remainingStrong
    }
  };
}

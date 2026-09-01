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
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2]
];

function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const p = y * width + x;
  const gx = ((alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0)) * 0.5;
  const gy = ((alphaMap[p + width] || 0) - (alphaMap[p - width] || 0)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function alphaBounds(alphaMap, width, height, threshold) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((alphaMap[y * width + x] || 0) < threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  if (!count) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, count };
}

export function buildContourSafetyBand(alphaMap, width, height, options = {}) {
  const n = width * height;
  const footprintAlpha = Number.isFinite(options.safetyFootprintAlpha) ? options.safetyFootprintAlpha : 0.004;
  const bounds = alphaBounds(alphaMap, width, height, footprintAlpha);
  const weight = new Float32Array(n);
  const guardAlpha = new Float32Array(alphaMap);
  const distance = new Int16Array(n);
  distance.fill(32767);
  if (!bounds) {
    return { weight, guardAlpha, distance, bounds: null, baseRadius: 0, tipExtraRadius: 0, pixels: 0 };
  }

  const referenceSize = Math.max(1, Math.max(bounds.width, bounds.height));
  const scale = clamp(referenceSize / 72, 0.60, 1.80);
  const baseRadius = Math.max(3, Math.min(8, Math.round(Number(options.safetyRadius ?? (5 * scale)))));
  const tipExtraRadius = Math.max(1, Math.min(4, Math.round(Number(options.safetyTipExtraRadius ?? (2 * scale)))));
  const maxRadius = baseRadius + tipExtraRadius;
  let current = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if ((alphaMap[p] || 0) < footprintAlpha) continue;
    current[p] = 1;
    distance[p] = 0;
  }

  for (let step = 1; step <= maxRadius; step++) {
    const next = new Uint8Array(current);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const p = y * width + x;
        if (current[p]) continue;
        let near = false;
        for (let oy = -1; oy <= 1 && !near; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            if (current[(y + oy) * width + x + ox]) { near = true; break; }
          }
        }
        if (!near) continue;
        next[p] = 1;
        distance[p] = step;
      }
    }
    current = next;
  }

  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  const halfW = Math.max(1, bounds.width * 0.5);
  const halfH = Math.max(1, bounds.height * 0.5);
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.28;
  let pixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const d = distance[p];
      if (d === 32767) continue;
      const nx = Math.abs(x - cx) / halfW;
      const ny = Math.abs(y - cy) / halfH;
      const axisTip = Math.max(nx * (1 - Math.min(1, ny)), ny * (1 - Math.min(1, nx)));
      const tipWeight = smoothstep(0.42, 0.84, axisTip);
      const allowedRadius = baseRadius + Math.round(tipExtraRadius * tipWeight);
      if (d > allowedRadius) continue;

      const alpha = alphaMap[p] || 0;
      let bandWeight = 0;
      if (d === 0) {
        const faintContour = 1 - smoothstep(maxAlpha * 0.68, maxAlpha, alpha);
        bandWeight = alpha <= maxAlpha ? Math.max(0.18, faintContour) : 0;
      } else {
        const outerTaper = 1 - smoothstep(Math.max(0.5, allowedRadius - 1.5), allowedRadius + 0.35, d);
        bandWeight = clamp(0.42 + outerTaper * 0.58, 0, 1);
      }
      if (bandWeight <= 0) continue;
      weight[p] = bandWeight;
      guardAlpha[p] = Math.max(alpha, 0.20 * bandWeight);
      pixels++;
    }
  }

  return { weight, guardAlpha, distance, bounds, baseRadius, tipExtraRadius, pixels };
}

function cleanAnchor(image, guideAlpha, x, y, nx, ny, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.014;
  const start = Math.max(2, Math.round(Number(options.anchorStart ?? 2)));
  const maxRadius = Math.max(start + 1, Math.min(24, Math.round(Number(options.maxRadius ?? 14))));
  for (let d = start; d <= maxRadius; d++) {
    const xx = Math.round(x + nx * d * sign);
    const yy = Math.round(y + ny * d * sign);
    if (xx < 2 || yy < 2 || xx >= image.width - 2 || yy >= image.height - 2) break;
    if ((guideAlpha[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance: d, x: xx, y: yy };
  }
  return null;
}

function directionalPrediction(image, guideAlpha, x, y, nx, ny, options = {}) {
  const negative = cleanAnchor(image, guideAlpha, x, y, nx, ny, -1, options);
  const positive = cleanAnchor(image, guideAlpha, x, y, nx, ny, 1, options);
  if (!negative || !positive) return null;
  const span = negative.distance + positive.distance;
  if (span <= 0) return null;
  const wn = positive.distance / span;
  const wp = negative.distance / span;
  const target = [0, 1, 2].map((c) => negative.rgb[c] * wn + positive.rgb[c] * wp);
  return {
    target,
    endpointLumaDelta: Math.abs(luma(negative.rgb) - luma(positive.rgb)),
    span
  };
}

function contourPrediction(image, guideAlpha, x, y, options = {}) {
  const gradient = alphaGradient(guideAlpha, image.width, image.height, x, y);
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.006;
  const predictions = [];

  if (gradient.magnitude >= minGradient) {
    const nx = gradient.gx / gradient.magnitude;
    const ny = gradient.gy / gradient.magnitude;
    const normal = directionalPrediction(image, guideAlpha, x, y, nx, ny, options);
    if (normal) predictions.push({ ...normal, priority: 0 });
  }

  for (const [dx, dy] of DIRECTIONS) {
    const candidate = directionalPrediction(image, guideAlpha, x, y, dx, dy, options);
    if (candidate) predictions.push({ ...candidate, priority: 1 });
  }
  if (!predictions.length) return null;

  predictions.sort((a, b) => (a.endpointLumaDelta + a.priority * 0.35) - (b.endpointLumaDelta + b.priority * 0.35));
  const selected = predictions.slice(0, Math.min(2, predictions.length));
  const weights = selected.map((item) => 1 / Math.max(1, item.endpointLumaDelta + item.span * 0.06));
  const weightSum = weights.reduce((sum, value) => sum + value, 0) || 1;
  const target = [0, 1, 2].map((c) => selected.reduce((sum, item, index) => sum + item.target[c] * weights[index], 0) / weightSum);
  return {
    target,
    gradient: gradient.magnitude,
    endpointLumaDelta: median(selected.map((item) => item.endpointLumaDelta)),
    span: median(selected.map((item) => item.span)),
    directions: selected.length
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
  const safetyStrength = clamp(Number(options.safetyStrength ?? 0.40), 0.16, 0.50);
  const safetyMaxBlend = clamp(Number(options.safetyMaxBlend ?? 0.32), 0.12, 0.38);
  const endpointSoft = Number.isFinite(options.endpointSoft) ? options.endpointSoft : 7;
  const endpointHard = Number.isFinite(options.endpointHard) ? options.endpointHard : 22;
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.65;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 4.2;
  const safetyResidualSoft = Number.isFinite(options.safetyResidualSoft) ? options.safetyResidualSoft : 0.55;
  const safetyResidualHard = Number.isFinite(options.safetyResidualHard) ? options.safetyResidualHard : 3.6;
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, options);
  let correctedPixels = 0;
  let safetyBandCorrectedPixels = 0;
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
      if (alpha > maxAlpha) continue;
      const guideGradient = alphaGradient(safety.guardAlpha, image.width, image.height, x, y);
      const contourWeight = smoothstep(options.minAlphaGradient ?? 0.006, options.fullAlphaGradient ?? 0.055, guideGradient.magnitude);
      const safetyWeight = options.safetyBand === false ? 0 : (safety.weight[p] || 0);
      const effectiveWeight = Math.max(contourWeight * (alpha >= minAlpha ? 1 : 0.72), safetyWeight);
      if (effectiveWeight < 0.08) continue;
      contourCandidates++;

      const scene = sceneEdgeProtectionAt(image, safety.guardAlpha, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        guardedPixels++;
        continue;
      }

      const prediction = contourPrediction(image, safety.guardAlpha, x, y, options);
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
      const inSafetyBand = alpha < minAlpha || safetyWeight > contourWeight;
      const residualGate = smoothstep(
        inSafetyBand ? safetyResidualSoft : residualSoft,
        inSafetyBand ? safetyResidualHard : residualHard,
        Math.abs(residual)
      );
      if (residualGate <= 0) continue;
      const sceneWeight = clamp(1 - scene.weight * 1.18, 0, 1);
      const localStrength = inSafetyBand ? safetyStrength : strength;
      const localMaxBlend = inSafetyBand ? safetyMaxBlend : maxBlend;
      const blend = Math.min(localMaxBlend, localStrength * effectiveWeight * endpointAgreement * residualGate * sceneWeight);
      if (blend < 0.025) continue;

      const delta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const idx = p * 4;
      const chromaBlend = Math.min(inSafetyBand ? 0.11 : 0.08, blend * (inSafetyBand ? 0.28 : 0.20));
      const next = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const lumaAdjusted = current[c] + delta;
        next[c] = clampByte(lumaAdjusted + (prediction.target[c] - lumaAdjusted) * chromaBlend);
        data[idx + c] = next[c];
      }
      correctedPixels++;
      if (inSafetyBand) safetyBandCorrectedPixels++;
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
    safetyBandCorrectedPixels,
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
    maxLumaDelta,
    safetyBand: {
      enabled: options.safetyBand !== false,
      pixels: safety.pixels,
      baseRadius: safety.baseRadius,
      tipExtraRadius: safety.tipExtraRadius,
      footprint: safety.bounds
    }
  };
}

function assessCandidate(candidate, alphaMap, beforeOutline, beforeGlobal, options = {}) {
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
    && afterOutline.score <= beforeOutline.score * 1.002
    && globalSafe;
  const accepted = standardAccepted || localBandAccepted;
  return {
    accepted,
    acceptanceMode: standardAccepted ? 'outline-wide' : (localBandAccepted ? 'local-band' : 'rejected'),
    standardAccepted,
    localBandAccepted,
    globalSafe,
    afterOutline,
    afterGlobal,
    improvement,
    minCorrectedPixels,
    minImprovement,
    maxOutlineRatio,
    maxMeanBlend,
    localMinImprovement,
    localMaxGuardedFraction,
    localMaxMeanBlend
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
        correctedPixels: 0,
        safetyBand: { enabled: options.safetyBand !== false, pixels: 0, baseRadius: 0, tipExtraRadius: 0 },
        rescuePassesAttempted: 0,
        rescuePassesAccepted: 0
      }
    };
  }

  const firstCandidate = buildCandidate(image, alphaMap, options);
  const firstAssessment = assessCandidate(firstCandidate, alphaMap, beforeOutline, beforeGlobal, options);
  let selected = firstAssessment.accepted
    ? { width: image.width, height: image.height, data: firstCandidate.data }
    : { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  let finalCandidate = firstCandidate;
  let finalAssessment = firstAssessment;
  let rescuePassesAttempted = 1;
  let rescuePassesAccepted = firstAssessment.accepted ? 1 : 0;

  const maxRescuePasses = Math.max(1, Math.min(2, Math.round(Number(options.maxRescuePasses ?? 2))));
  if (firstAssessment.accepted && maxRescuePasses > 1 && firstCandidate.safetyBandCorrectedPixels > 0) {
    const secondOptions = {
      ...options,
      safetyRadius: firstCandidate.safetyBand.baseRadius + 2,
      safetyTipExtraRadius: firstCandidate.safetyBand.tipExtraRadius + 1,
      safetyStrength: Math.min(0.46, Number(options.safetyStrength ?? 0.40) * 0.92),
      safetyMaxBlend: Math.min(0.34, Number(options.safetyMaxBlend ?? 0.32) * 0.94)
    };
    const secondCandidate = buildCandidate(selected, alphaMap, secondOptions);
    const secondAssessment = assessCandidate(secondCandidate, alphaMap, firstAssessment.afterOutline, beforeGlobal, secondOptions);
    rescuePassesAttempted++;
    if (secondAssessment.accepted) {
      selected = { width: image.width, height: image.height, data: secondCandidate.data };
      finalCandidate = secondCandidate;
      finalAssessment = secondAssessment;
      rescuePassesAccepted++;
    }
  }

  const accepted = rescuePassesAccepted > 0;
  return {
    width: image.width,
    height: image.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    contourMicroInterpolation: {
      eligible,
      attempted: true,
      accepted,
      acceptanceMode: accepted ? finalAssessment.acceptanceMode : 'rejected',
      standardAccepted: accepted ? finalAssessment.standardAccepted : false,
      localBandAccepted: accepted ? finalAssessment.localBandAccepted : false,
      globalSafe: finalAssessment.globalSafe,
      beforeOutline,
      afterOutline: accepted ? finalAssessment.afterOutline : beforeOutline,
      candidateAfterOutline: finalAssessment.afterOutline,
      improvement: accepted ? ((beforeOutline.score - finalAssessment.afterOutline.score) / Math.max(1e-9, beforeOutline.score)) : 0,
      candidateImprovement: finalAssessment.improvement,
      beforeGlobal,
      afterGlobal: accepted ? finalAssessment.afterGlobal : beforeGlobal,
      candidateAfterGlobal: finalAssessment.afterGlobal,
      correctedPixels: accepted ? finalCandidate.correctedPixels : 0,
      candidateCorrectedPixels: finalCandidate.correctedPixels,
      safetyBandCorrectedPixels: accepted ? finalCandidate.safetyBandCorrectedPixels : 0,
      candidateSafetyBandCorrectedPixels: finalCandidate.safetyBandCorrectedPixels,
      guardedPixels: finalCandidate.guardedPixels,
      contourCandidates: finalCandidate.contourCandidates,
      guardedFraction: finalCandidate.guardedFraction,
      missingAnchors: finalCandidate.missingAnchors,
      meanBlend: accepted ? finalCandidate.meanBlend : 0,
      candidateMeanBlend: finalCandidate.meanBlend,
      localBeforeResidual: finalCandidate.localBeforeResidual,
      localAfterResidual: finalCandidate.localAfterResidual,
      localImprovement: finalCandidate.localImprovement,
      minCorrectedPixels: finalAssessment.minCorrectedPixels,
      minImprovement: finalAssessment.minImprovement,
      maxOutlineRatio: finalAssessment.maxOutlineRatio,
      maxMeanBlend: finalAssessment.maxMeanBlend,
      localMinImprovement: finalAssessment.localMinImprovement,
      localMaxGuardedFraction: finalAssessment.localMaxGuardedFraction,
      localMaxMeanBlend: finalAssessment.localMaxMeanBlend,
      hardSceneGuard: finalCandidate.hardSceneGuard,
      strength: finalCandidate.strength,
      maxBlend: finalCandidate.maxBlend,
      maxLumaDelta: finalCandidate.maxLumaDelta,
      safetyBand: finalCandidate.safetyBand,
      rescuePassesAttempted,
      rescuePassesAccepted,
      maxRescuePasses
    }
  };
}

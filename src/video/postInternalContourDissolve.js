import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureGeometricOutlineResidual } from './protectedResidualRescue.js';
import { sceneEdgeProtectionAt } from './sceneEdgeProtection.js';
import { buildContourSafetyBand } from './contourMicroInterpolation.js';

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
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}
function optionalDeltaSafe(after, before, tolerance) {
  if (!Number.isFinite(after) || !Number.isFinite(before)) return true;
  return after <= before + tolerance;
}

function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
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

function outwardDirection(alphaMap, width, height, safety, x, y, options = {}) {
  const gradient = alphaGradient(alphaMap, width, height, x, y);
  const gradientFloor = Number.isFinite(options.directionGradientFloor) ? options.directionGradientFloor : 0.0015;
  if (gradient.magnitude >= gradientFloor) {
    return { x: -gradient.gx / gradient.magnitude, y: -gradient.gy / gradient.magnitude, gradient: gradient.magnitude, fallback: false };
  }
  const bounds = safety?.bounds;
  if (!bounds) return null;
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  const dx = x - cx;
  const dy = y - cy;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 1e-6) return null;
  return { x: dx / magnitude, y: dy / magnitude, gradient: gradient.magnitude, fallback: true };
}

function fitOuterRay(image, alphaMap, safety, x, y, dx, dy, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.010;
  const maxAnchorSafetyWeight = Number.isFinite(options.maxAnchorSafetyWeight) ? options.maxAnchorSafetyWeight : 0.04;
  const maxRadius = Math.max(7, Math.min(28, Math.round(Number(options.maxRadius ?? 18))));
  const minSamples = Math.max(3, Math.min(5, Math.round(Number(options.raySamples ?? 3))));
  const points = [];
  let lastX = -999;
  let lastY = -999;

  for (let distance = 2; distance <= maxRadius && points.length < minSamples; distance += 1) {
    const xx = Math.round(x + dx * distance);
    const yy = Math.round(y + dy * distance);
    if (xx < 2 || yy < 2 || xx >= image.width - 2 || yy >= image.height - 2) break;
    if (xx === lastX && yy === lastY) continue;
    lastX = xx;
    lastY = yy;
    const p = yy * image.width + xx;
    if ((alphaMap[p] || 0) > cleanAlpha) continue;
    if ((safety.weight[p] || 0) > maxAnchorSafetyWeight) continue;
    const rgb = rgbAt(image, xx, yy);
    points.push({ distance, rgb, y: luma(rgb) });
  }
  if (points.length < minSamples) return null;

  const meanD = points.reduce((sum, point) => sum + point.distance, 0) / points.length;
  const varianceD = points.reduce((sum, point) => sum + (point.distance - meanD) ** 2, 0);
  if (varianceD < 1e-6) return null;
  const target = [0, 1, 2].map((channel) => {
    const meanV = points.reduce((sum, point) => sum + point.rgb[channel], 0) / points.length;
    const slope = points.reduce((sum, point) => sum + (point.distance - meanD) * (point.rgb[channel] - meanV), 0) / varianceD;
    const intercept = meanV - slope * meanD;
    const values = points.map((point) => point.rgb[channel]);
    const min = Math.min(...values) - 5;
    const max = Math.max(...values) + 5;
    return clamp(intercept, min, max);
  });

  const targetY = luma(target);
  const ys = points.map((point) => point.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const medianY = median(ys);
  const range = maxY - minY;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const slopeY = points.reduce((sum, point) => sum + (point.distance - meanD) * (point.y - meanY), 0) / varianceD;
  const interceptY = meanY - slopeY * meanD;
  const regressionMae = points.reduce((sum, point) => sum + Math.abs(point.y - (interceptY + slopeY * point.distance)), 0) / points.length;

  return {
    target,
    targetY,
    points,
    firstDistance: points[0].distance,
    minY,
    maxY,
    medianY,
    lumaRange: range,
    regressionMae
  };
}

function outerPrediction(image, alphaMap, safety, x, y, options = {}) {
  const outward = outwardDirection(alphaMap, image.width, image.height, safety, x, y, options);
  if (!outward) return null;
  const angleOffsets = options.rayAngles || [0, Math.PI / 12, -Math.PI / 12, Math.PI / 6, -Math.PI / 6];
  const candidates = [];
  for (const angle of angleOffsets) {
    const [dx, dy] = rotate(outward.x, outward.y, angle);
    const ray = fitOuterRay(image, alphaMap, safety, x, y, dx, dy, options);
    if (!ray) continue;
    const anglePenalty = Math.abs(angle) * 0.35;
    const score = ray.regressionMae + ray.lumaRange * 0.10 + ray.firstDistance * 0.035 + anglePenalty;
    candidates.push({ ...ray, dx, dy, angle, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const textureSignal = best.lumaRange + best.regressionMae * 1.8;
  const textureComplexity = smoothstep(options.textureSoft ?? 4.5, options.textureHard ?? 16.0, textureSignal);

  if (textureComplexity >= 0.52 || candidates.length === 1) {
    return { ...best, textureComplexity, rays: candidates.length, outward };
  }

  const second = candidates[1];
  const w1 = 1 / Math.max(0.5, best.score + 0.5);
  const w2 = 1 / Math.max(0.5, second.score + 0.5);
  const sum = w1 + w2;
  const target = [0, 1, 2].map((channel) => (best.target[channel] * w1 + second.target[channel] * w2) / sum);
  return {
    ...best,
    target,
    targetY: luma(target),
    minY: Math.min(best.minY, second.minY),
    maxY: Math.max(best.maxY, second.maxY),
    medianY: (best.medianY * w1 + second.medianY * w2) / sum,
    lumaRange: Math.max(best.lumaRange, second.lumaRange),
    regressionMae: (best.regressionMae * w1 + second.regressionMae * w2) / sum,
    textureComplexity,
    rays: candidates.length,
    outward
  };
}

function outlineMeasureOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.minAlpha) ? options.minAlpha : 0.010,
    outlineMaxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.42,
    outlineResidualSoft: Number.isFinite(options.measureResidualSoft) ? options.measureResidualSoft : 0.38,
    outlineResidualHard: Number.isFinite(options.measureResidualHard) ? options.measureResidualHard : 3.4,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.64,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, {
    ...options,
    maxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.42,
    safetyRadius: Number.isFinite(options.safetyRadius) ? options.safetyRadius : 4,
    safetyTipExtraRadius: Number.isFinite(options.safetyTipExtraRadius) ? options.safetyTipExtraRadius : 2
  });
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.010;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.42;
  const minGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.0025;
  const fullGradient = Number.isFinite(options.fullAlphaGradient) ? options.fullAlphaGradient : 0.040;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.40;
  const smoothStrength = clamp(Number(options.smoothStrength ?? 0.58), 0.18, 0.72);
  const structuredStrength = clamp(Number(options.structuredStrength ?? 0.34), 0.12, 0.50);
  const smoothMaxBlend = clamp(Number(options.smoothMaxBlend ?? 0.42), 0.16, 0.48);
  const structuredMaxBlend = clamp(Number(options.structuredMaxBlend ?? 0.27), 0.10, 0.36);
  const smoothMaxLumaDelta = clamp(Number(options.smoothMaxLumaDelta ?? 11), 4, 14);
  const structuredMaxLumaDelta = clamp(Number(options.structuredMaxLumaDelta ?? 8), 3, 11);
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.38;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 3.0;
  let contourCandidates = 0;
  let correctedPixels = 0;
  let structuredCorrectedPixels = 0;
  let sceneGuardedPixels = 0;
  let missingOuterPrediction = 0;
  let artifactVetoPixels = 0;
  let fallbackDirectionPixels = 0;
  let blendSum = 0;
  let textureSum = 0;
  let localBeforeResidualSum = 0;
  let localAfterResidualSum = 0;
  let maxAppliedLumaDelta = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      const gradient = alphaGradient(alphaMap, image.width, image.height, x, y);
      const safetyWeight = safety.weight[p] || 0;
      const edgeBand = smoothstep(minGradient, fullGradient, gradient.magnitude);
      const faintOuter = alpha < minAlpha && safety.distance[p] <= 1 && edgeBand >= 0.18;
      if (!faintOuter && (alpha < minAlpha || alpha > maxAlpha)) continue;
      const alphaEnvelope = alpha <= maxAlpha
        ? 1 - 0.60 * smoothstep(maxAlpha * 0.70, maxAlpha, alpha)
        : 0;
      const contourWeight = Math.max(edgeBand, Math.min(0.72, safetyWeight * 0.72)) * alphaEnvelope;
      if (contourWeight < 0.08) continue;
      contourCandidates++;

      const scene = sceneEdgeProtectionAt(image, safety.guardAlpha, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        sceneGuardedPixels++;
        continue;
      }

      const prediction = outerPrediction(image, alphaMap, safety, x, y, options);
      if (!prediction) {
        missingOuterPrediction++;
        continue;
      }
      if (prediction.outward?.fallback) fallbackDirectionPixels++;

      const currentRgb = rgbAt(image, x, y);
      const current = rgbToYcbcr(currentRgb);
      const target = rgbToYcbcr(prediction.target);
      const residual = target[0] - current[0];
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0) continue;

      const texture = prediction.textureComplexity;
      const localStrength = smoothStrength * (1 - texture) + structuredStrength * texture;
      const localMaxBlend = smoothMaxBlend * (1 - texture) + structuredMaxBlend * texture;
      const maxLumaDelta = smoothMaxLumaDelta * (1 - texture) + structuredMaxLumaDelta * texture;
      const sceneWeight = clamp(1 - scene.weight * 1.35, 0, 1);
      const blend = Math.min(localMaxBlend, localStrength * contourWeight * residualGate * sceneWeight);
      if (blend < 0.025) continue;

      const requestedDelta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const candidateY = current[0] + requestedDelta;
      const localMargin = Number(options.localArtifactMargin ?? 6) + texture * 3;
      const minAllowed = prediction.minY - localMargin;
      const maxAllowed = prediction.maxY + localMargin;
      const maxMedianDeviation = Math.max(Number(options.minMedianDeviation ?? 10), prediction.lumaRange * 0.85 + 8);
      const improvesResidual = Math.abs(target[0] - candidateY) + 0.02 < Math.abs(residual);
      const rangeSafe = candidateY >= minAllowed && candidateY <= maxAllowed;
      const medianSafe = Math.abs(candidateY - prediction.medianY) <= maxMedianDeviation;
      if (!improvesResidual || !rangeSafe || !medianSafe) {
        artifactVetoPixels++;
        continue;
      }

      const chromaFactor = 0.14 - texture * 0.09;
      const chromaBlend = Math.min(0.055, Math.max(0.012, blend * chromaFactor));
      const cb = current[1] + clamp(target[1] - current[1], -7, 7) * chromaBlend;
      const cr = current[2] + clamp(target[2] - current[2], -7, 7) * chromaBlend;
      const nextRgb = ycbcrToRgb(candidateY, cb, cr);
      const nextY = luma(nextRgb);
      if (nextY < minAllowed - 0.5 || nextY > maxAllowed + 0.5) {
        artifactVetoPixels++;
        continue;
      }

      const idx = p * 4;
      data[idx] = nextRgb[0];
      data[idx + 1] = nextRgb[1];
      data[idx + 2] = nextRgb[2];
      correctedPixels++;
      if (texture >= 0.52) structuredCorrectedPixels++;
      blendSum += blend;
      textureSum += texture;
      localBeforeResidualSum += Math.abs(residual);
      localAfterResidualSum += Math.abs(target[0] - nextY);
      maxAppliedLumaDelta = Math.max(maxAppliedLumaDelta, Math.abs(nextY - current[0]));
    }
  }

  const localBeforeResidual = correctedPixels ? localBeforeResidualSum / correctedPixels : 0;
  const localAfterResidual = correctedPixels ? localAfterResidualSum / correctedPixels : 0;
  const localImprovement = localBeforeResidual > 1e-9
    ? (localBeforeResidual - localAfterResidual) / localBeforeResidual
    : 0;
  const attemptedPixels = correctedPixels + artifactVetoPixels;

  return {
    width: image.width,
    height: image.height,
    data,
    contourCandidates,
    correctedPixels,
    structuredCorrectedPixels,
    sceneGuardedPixels,
    missingOuterPrediction,
    artifactVetoPixels,
    artifactVetoFraction: attemptedPixels ? artifactVetoPixels / attemptedPixels : 0,
    fallbackDirectionPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanTextureComplexity: correctedPixels ? textureSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    maxAppliedLumaDelta,
    safetyBand: {
      pixels: safety.pixels,
      baseRadius: safety.baseRadius,
      tipExtraRadius: safety.tipExtraRadius,
      footprint: safety.bounds
    }
  };
}

function assessCandidate(candidate, alphaMap, beforeOutline, beforeGlobal, options = {}) {
  const afterOutline = measureGeometricOutlineResidual(candidate, alphaMap, outlineMeasureOptions(options));
  const afterGlobal = measurePostCleanupResidual(candidate, alphaMap);
  const improvement = beforeOutline.score > 1e-9
    ? (beforeOutline.score - afterOutline.score) / beforeOutline.score
    : 0;
  const minCorrectedPixels = Math.max(3, Math.round(Number(options.minCorrectedPixels ?? 4)));
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.055;
  const maxMeanBlend = Number.isFinite(options.maxMeanBlend) ? options.maxMeanBlend : 0.34;
  const maxArtifactVetoFraction = Number.isFinite(options.maxArtifactVetoFraction) ? options.maxArtifactVetoFraction : 0.72;
  const enoughPixels = candidate.correctedPixels >= minCorrectedPixels;
  const localGood = candidate.localImprovement >= minLocalImprovement;
  const outlineSafe = beforeOutline.score < 0.20
    ? afterOutline.score <= 0.36
    : afterOutline.score <= beforeOutline.score * (options.maxOutlineRatio ?? 1.002);
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.003 + 0.025
    && afterGlobal.luma <= beforeGlobal.luma * 1.004 + 0.035
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.003 + 0.22
    && optionalDeltaSafe(afterGlobal.darkCandidateMean, beforeGlobal.darkCandidateMean, 0.30)
    && optionalDeltaSafe(afterGlobal.darkCandidatePeak, beforeGlobal.darkCandidatePeak, 1.05)
    && optionalDeltaSafe(afterGlobal.clipFraction, beforeGlobal.clipFraction, 0.001);
  const artifactSafe = candidate.artifactVetoFraction <= maxArtifactVetoFraction
    && candidate.meanBlend <= maxMeanBlend + 1e-6;
  const accepted = enoughPixels && localGood && outlineSafe && globalSafe && artifactSafe;
  return {
    accepted,
    afterOutline,
    afterGlobal,
    improvement,
    enoughPixels,
    localGood,
    outlineSafe,
    globalSafe,
    artifactSafe,
    minCorrectedPixels,
    minLocalImprovement,
    maxMeanBlend,
    maxArtifactVetoFraction
  };
}

export function applyPostInternalContourDissolve(image, alphaMap, options = {}) {
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineMeasureOptions(options));
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, {
    ...options,
    maxAlpha: Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.42
  });
  const minContourPixels = Math.max(8, Math.round(Number(options.minContourPixels ?? 12)));
  const eligible = options.enabled !== false && Boolean(safety.bounds) && beforeOutline.contourPixels >= minContourPixels;
  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      postInternalContourDissolve: {
        eligible,
        attempted: false,
        accepted: false,
        beforeOutline,
        afterOutline: beforeOutline,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        correctedPixels: 0,
        artifactVetoPixels: 0,
        passesAttempted: 0,
        passesAccepted: 0
      }
    };
  }

  const firstCandidate = buildCandidate(image, alphaMap, options);
  const firstAssessment = assessCandidate(firstCandidate, alphaMap, beforeOutline, beforeGlobal, options);
  let selected = firstAssessment.accepted
    ? { width: image.width, height: image.height, data: new Uint8ClampedArray(firstCandidate.data) }
    : { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  let finalCandidate = firstCandidate;
  let finalAssessment = firstAssessment;
  let passesAttempted = 1;
  let passesAccepted = firstAssessment.accepted ? 1 : 0;

  const maxPasses = Math.max(1, Math.min(2, Math.round(Number(options.maxPasses ?? 2))));
  if (firstAssessment.accepted && maxPasses > 1 && firstCandidate.correctedPixels > 0) {
    const secondOptions = {
      ...options,
      smoothStrength: Number(options.smoothStrength ?? 0.58) * 0.82,
      structuredStrength: Number(options.structuredStrength ?? 0.34) * 0.88,
      smoothMaxBlend: Number(options.smoothMaxBlend ?? 0.42) * 0.88,
      structuredMaxBlend: Number(options.structuredMaxBlend ?? 0.27) * 0.90,
      minLocalImprovement: Math.max(0.04, Number(options.minLocalImprovement ?? 0.055) * 0.88)
    };
    const secondCandidate = buildCandidate(selected, alphaMap, secondOptions);
    const secondAssessment = assessCandidate(secondCandidate, alphaMap, firstAssessment.afterOutline, beforeGlobal, secondOptions);
    passesAttempted++;
    if (secondAssessment.accepted) {
      selected = { width: image.width, height: image.height, data: new Uint8ClampedArray(secondCandidate.data) };
      finalCandidate = secondCandidate;
      finalAssessment = secondAssessment;
      passesAccepted++;
    }
  }

  const accepted = passesAccepted > 0;
  return {
    width: image.width,
    height: image.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    postInternalContourDissolve: {
      eligible,
      attempted: true,
      accepted,
      beforeOutline,
      afterOutline: accepted ? finalAssessment.afterOutline : beforeOutline,
      candidateAfterOutline: finalAssessment.afterOutline,
      beforeGlobal,
      afterGlobal: accepted ? finalAssessment.afterGlobal : beforeGlobal,
      candidateAfterGlobal: finalAssessment.afterGlobal,
      improvement: accepted && beforeOutline.score > 1e-9
        ? (beforeOutline.score - finalAssessment.afterOutline.score) / beforeOutline.score
        : 0,
      candidateImprovement: finalAssessment.improvement,
      correctedPixels: accepted ? finalCandidate.correctedPixels : 0,
      candidateCorrectedPixels: finalCandidate.correctedPixels,
      structuredCorrectedPixels: accepted ? finalCandidate.structuredCorrectedPixels : 0,
      sceneGuardedPixels: finalCandidate.sceneGuardedPixels,
      missingOuterPrediction: finalCandidate.missingOuterPrediction,
      artifactVetoPixels: finalCandidate.artifactVetoPixels,
      artifactVetoFraction: finalCandidate.artifactVetoFraction,
      fallbackDirectionPixels: finalCandidate.fallbackDirectionPixels,
      meanBlend: accepted ? finalCandidate.meanBlend : 0,
      candidateMeanBlend: finalCandidate.meanBlend,
      meanTextureComplexity: finalCandidate.meanTextureComplexity,
      localBeforeResidual: finalCandidate.localBeforeResidual,
      localAfterResidual: finalCandidate.localAfterResidual,
      localImprovement: finalCandidate.localImprovement,
      maxAppliedLumaDelta: finalCandidate.maxAppliedLumaDelta,
      globalSafe: finalAssessment.globalSafe,
      outlineSafe: finalAssessment.outlineSafe,
      artifactSafe: finalAssessment.artifactSafe,
      minCorrectedPixels: finalAssessment.minCorrectedPixels,
      minLocalImprovement: finalAssessment.minLocalImprovement,
      maxMeanBlend: finalAssessment.maxMeanBlend,
      maxArtifactVetoFraction: finalAssessment.maxArtifactVetoFraction,
      safetyBand: finalCandidate.safetyBand,
      passesAttempted,
      passesAccepted,
      maxPasses
    }
  };
}

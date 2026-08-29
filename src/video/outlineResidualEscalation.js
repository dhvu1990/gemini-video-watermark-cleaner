import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from './sceneEdgeProtection.js';
import { measureGeometricOutlineResidual, measureProtectedResidualField } from './protectedResidualRescue.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function rgbAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function alphaContourWeight(alphaMap, width, height, x, y, options = {}) {
  const alpha = alphaMap[y * width + x] || 0;
  const low = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.018;
  const high = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.30;
  if (alpha < low || alpha > high) return 0;
  let localMin = alpha;
  let localMax = alpha;
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      if (!ox && !oy) continue;
      const xx = x + ox;
      const yy = y + oy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const a = alphaMap[yy * width + xx] || 0;
      localMin = Math.min(localMin, a);
      localMax = Math.max(localMax, a);
    }
  }
  const transition = smoothstep(options.gradientSoft ?? 0.018, options.gradientHard ?? 0.12, localMax - localMin);
  const bandIn = smoothstep(low, options.bandPeakLow ?? 0.06, alpha);
  const bandOut = 1 - smoothstep(options.bandPeakHigh ?? 0.18, high, alpha);
  return clamp(transition * (0.30 + 0.70 * bandIn * bandOut), 0, 1);
}

function cleanAnchor(image, alphaMap, x, y, dx, dy, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.014;
  const maxRadius = Math.max(10, Math.min(40, Number(options.maxRadius ?? 30)));
  for (let d = 3; d <= maxRadius; d++) {
    const xx = Math.round(x + dx * d * sign);
    const yy = Math.round(y + dy * d * sign);
    if (xx < 1 || yy < 1 || xx >= image.width - 1 || yy >= image.height - 1) break;
    if ((alphaMap[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance: d };
  }
  return null;
}

const DIRS = [
  [1, 0], [0, 1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2]
];

function prediction(image, alphaMap, x, y, options = {}) {
  const estimates = [];
  for (const [dx, dy] of DIRS) {
    const a = cleanAnchor(image, alphaMap, x, y, dx, dy, -1, options);
    const b = cleanAnchor(image, alphaMap, x, y, dx, dy, 1, options);
    if (!a || !b) continue;
    const span = a.distance + b.distance;
    const wa = b.distance / span;
    const wb = a.distance / span;
    estimates.push({
      rgb: [0, 1, 2].map((c) => a.rgb[c] * wa + b.rgb[c] * wb),
      disagreement: Math.abs(luma(a.rgb) - luma(b.rgb))
    });
  }
  if (estimates.length < 2) return null;
  const target = [0, 1, 2].map((c) => median(estimates.map((item) => item.rgb[c])));
  const ys = estimates.map((item) => luma(item.rgb));
  return {
    rgb: target,
    spread: Math.max(...ys) - Math.min(...ys),
    disagreement: median(estimates.map((item) => item.disagreement)),
    directions: estimates.length
  };
}

function residualBodyWeak(body, outline, options = {}) {
  const maxBodyScore = Number.isFinite(options.maxBodyScore) ? options.maxBodyScore : 2.35;
  const maxBodyDensity = Number.isFinite(options.maxBodyDensity) ? options.maxBodyDensity : 0.38;
  const lowBodyScoreOverride = Number.isFinite(options.lowBodyScoreOverride) ? options.lowBodyScoreOverride : 0.50;
  const outlineDominance = outline.score / Math.max(0.35, body.score);
  const bodyScoreWeak = body.score <= maxBodyScore;
  const bodyDensityWeak = body.candidateDensity <= maxBodyDensity;
  // measureProtectedResidualField.candidateDensity is measurement coverage, not
  // strictly the density of visibly damaged pixels. On a smooth field it can be
  // near 1.0 even when the measured body residual itself is negligible. Allow
  // that dense-but-quiet case only under a much tighter body-score ceiling.
  const bodyQuietOverride = body.score <= lowBodyScoreOverride;
  const dominanceSafe = outlineDominance >= (options.minOutlineDominance ?? 0.82);
  return {
    weak: bodyScoreWeak && (bodyDensityWeak || bodyQuietOverride) && dominanceSafe,
    bodyScoreWeak,
    bodyDensityWeak,
    bodyQuietOverride,
    lowBodyScoreOverride,
    outlineDominance,
    dominanceSafe
  };
}

function safeContourEvidence(outline = {}) {
  const contourPixels = Math.max(0, Number(outline.contourPixels) || 0);
  const guardedPixels = Math.max(0, Math.min(contourPixels, Number(outline.sceneGuarded) || 0));
  const safeContourPixels = Math.max(0, contourPixels - guardedPixels);
  const safeContourRatio = contourPixels ? safeContourPixels / contourPixels : 0;
  const safeSampleDensity = safeContourPixels
    ? Math.max(0, Number(outline.samples) || 0) / safeContourPixels
    : 0;
  return { contourPixels, guardedPixels, safeContourPixels, safeContourRatio, safeSampleDensity };
}

function partialSceneEligibility(crossingSceneEdge, outline, guardedRatio, options = {}) {
  const minScore = Math.max(options.minOutlineScore ?? 1.15, options.partialMinOutlineScore ?? 1.22);
  const minDensity = Math.max(options.minOutlineDensity ?? 0.075, options.partialMinOutlineDensity ?? 0.075);
  const minSamples = Math.max(options.minOutlineSamples ?? 12, options.partialMinOutlineSamples ?? 12);
  const evidenceStrong = outline.score >= minScore
    && outline.candidateDensity >= minDensity
    && outline.samples >= minSamples;

  const safeContour = safeContourEvidence(outline);
  const minSafeContourPixels = Math.max(10, Math.round(Number(options.partialMinSafeContourPixels ?? 18)));
  const minSafeContourRatio = clamp(Number(options.partialMinSafeContourRatio ?? 0.58), 0.30, 0.95);
  const minSafeSampleDensity = clamp(Number(options.partialMinSafeSampleDensity ?? 0.045), 0.005, 0.50);
  const safeCoverage = safeContour.safeContourPixels >= minSafeContourPixels
    && safeContour.safeContourRatio >= minSafeContourRatio
    && safeContour.safeSampleDensity >= minSafeSampleDensity;

  // The global crossing metric can be high because a single genuine line cuts
  // through the ROI, or because a residual diamond is imperfectly registered.
  // Use it only as a dense-complexity veto. Eligibility is primarily based on
  // watermark-contour evidence that remains after per-pixel scene guards.
  const maxGlobalScore = clamp(Number(options.maxPartialCrossingSceneEdgeScore ?? 0.98), 0.30, 1);
  const maxGlobalDensity = clamp(Number(options.maxPartialSceneEdgeDensity ?? 0.32), 0.05, 0.70);
  const maxGlobalContinuityDensity = clamp(Number(options.maxPartialSceneEdgeContinuityDensity ?? 0.24), 0.02, 0.60);
  const globalComplexitySafe = Number(crossingSceneEdge?.score ?? 1) <= maxGlobalScore
    && Number(crossingSceneEdge?.density ?? 1) <= maxGlobalDensity
    && Number(crossingSceneEdge?.continuityDensity ?? 1) <= maxGlobalContinuityDensity;
  const maxPartialGuardedRatio = clamp(Number(options.maxPartialSceneGuardedRatio ?? 0.34), 0.10, 0.65);
  const contourLocalizationSafe = guardedRatio <= maxPartialGuardedRatio;

  return {
    eligible: evidenceStrong && safeCoverage && globalComplexitySafe && contourLocalizationSafe,
    evidenceStrong,
    safeCoverage,
    globalComplexitySafe,
    contourLocalizationSafe,
    safeContour,
    guardedRatio,
    minScore,
    minDensity,
    minSamples,
    minSafeContourPixels,
    minSafeContourRatio,
    minSafeSampleDensity,
    maxGlobalScore,
    maxGlobalDensity,
    maxGlobalContinuityDensity,
    maxPartialGuardedRatio
  };
}

function contourBodyOverrideEligibility(body, outline, options = {}) {
  const enabled = options.contourBodyOverride === true;
  const minScore = Math.max(options.minOutlineScore ?? 1.15, options.bodyOverrideMinOutlineScore ?? 1.35);
  const minDensity = Math.max(options.minOutlineDensity ?? 0.075, options.bodyOverrideMinOutlineDensity ?? 0.085);
  const minSamples = Math.max(options.minOutlineSamples ?? 12, options.bodyOverrideMinOutlineSamples ?? 16);
  const minSectorSupport = Math.max(options.minSectorSupport ?? 3, options.bodyOverrideMinSectorSupport ?? 4);
  const maxBodyScore = Math.max(0.5, Number(options.bodyOverrideMaxBodyScore ?? 6.0));
  const minDominance = clamp(Number(options.bodyOverrideMinDominance ?? 0.42), 0.05, 1.50);
  const outlineDominance = outline.score / Math.max(0.35, body.score);
  const outlineStrong = outline.score >= minScore
    && outline.candidateDensity >= minDensity
    && outline.samples >= minSamples
    && outline.sectorSupport >= minSectorSupport;
  const bodyBounded = body.score <= maxBodyScore;
  const dominanceSafe = outlineDominance >= minDominance;
  return {
    eligible: enabled && outlineStrong && bodyBounded && dominanceSafe,
    enabled,
    outlineStrong,
    bodyBounded,
    dominanceSafe,
    outlineDominance,
    minScore,
    minDensity,
    minSamples,
    minSectorSupport,
    maxBodyScore,
    minDominance
  };
}

function eligibility(image, alphaMap, options = {}) {
  const outline = measureGeometricOutlineResidual(image, alphaMap, {
    ...options,
    outlineMinAlpha: options.minAlpha ?? 0.018,
    outlineMaxAlpha: options.maxAlpha ?? 0.30,
    outlineResidualSoft: options.residualSoft ?? 0.55,
    outlineResidualHard: options.residualHard ?? 3.8
  });
  const body = measureProtectedResidualField(image, alphaMap, options);
  const crossingSceneEdge = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});
  const sectorSafe = outline.sectorSupport >= (options.minSectorSupport ?? 3);
  const strongOutline = outline.score >= (options.minOutlineScore ?? 1.15)
    && outline.candidateDensity >= (options.minOutlineDensity ?? 0.075)
    && outline.samples >= (options.minOutlineSamples ?? 12);
  const bodyGate = residualBodyWeak(body, outline, options);
  const bodyOverrideGate = contourBodyOverrideEligibility(body, outline, options);
  const contourBodyOverride = !bodyGate.weak && bodyOverrideGate.eligible;
  const bodyEligible = bodyGate.weak || contourBodyOverride;
  const bodyMode = bodyGate.weak ? 'weak-body' : (contourBodyOverride ? 'contour-only-override' : 'blocked');

  const guardedRatio = outline.contourPixels > 0 ? outline.sceneGuarded / outline.contourPixels : 1;
  const contourSceneSafe = guardedRatio <= (options.maxSceneGuardedRatio ?? 0.34);
  const crossingSceneSafe = !crossingSceneEdge.protect
    && crossingSceneEdge.level !== 'high'
    && Number(crossingSceneEdge.score ?? 1) <= (options.maxCrossingSceneEdgeScore ?? 0.30);
  const sceneSafe = contourSceneSafe && crossingSceneSafe;
  const partialSceneGate = partialSceneEligibility(crossingSceneEdge, outline, guardedRatio, options);
  // A localized real line must not disable cleanup of every other low-alpha
  // diamond-contour pixel. The candidate pass still applies a stricter scene
  // guard at each pixel, and the normal before/after rollback metrics remain.
  const partialSceneProtected = options.partialSceneProtection !== false
    && contourSceneSafe
    && !crossingSceneSafe
    && partialSceneGate.eligible;
  const sceneEligible = sceneSafe || partialSceneProtected;
  const sceneMode = sceneSafe ? 'full' : (partialSceneProtected ? 'partial-protected' : 'blocked');

  return {
    eligible: options.enabled !== false && strongOutline && sectorSafe && bodyEligible && sceneEligible,
    strongOutline,
    sectorSafe,
    bodyEligible,
    bodyMode,
    bodyWeak: bodyGate.weak,
    bodyScoreWeak: bodyGate.bodyScoreWeak,
    bodyDensityWeak: bodyGate.bodyDensityWeak,
    bodyQuietOverride: bodyGate.bodyQuietOverride,
    lowBodyScoreOverride: bodyGate.lowBodyScoreOverride,
    outlineDominance: bodyGate.outlineDominance,
    bodyDominanceSafe: bodyGate.dominanceSafe,
    contourBodyOverride,
    bodyOverrideGate,
    sceneSafe,
    sceneEligible,
    sceneMode,
    partialSceneProtected,
    partialSceneGate,
    contourSceneSafe,
    crossingSceneSafe,
    crossingSceneEdge,
    guardedRatio,
    outline,
    body
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  let correctedPixels = 0;
  let guardedPixels = 0;
  let blendSum = 0;
  const partialSceneProtected = options.partialSceneProtected === true;
  const contourBodyOverride = options.contourBodyOverrideActive === true;
  const requestedStrength = clamp(Number(options.strength ?? 0.58), 0.20, 0.72);
  const requestedMaxBlend = clamp(Number(options.maxBlend ?? 0.48), 0.18, 0.56);
  const requestedMaxDelta = Math.max(4, Math.min(14, Number(options.maxLumaDelta ?? 11)));

  let strength = requestedStrength;
  let maxBlend = requestedMaxBlend;
  let maxDelta = requestedMaxDelta;
  let hardSceneGuard = options.hardSceneGuard ?? 0.62;
  let sceneAttenuation = 0.97;

  if (partialSceneProtected) {
    strength = Math.min(strength, clamp(Number(options.partialStrength ?? 0.50), 0.20, 0.58));
    maxBlend = Math.min(maxBlend, clamp(Number(options.partialMaxBlend ?? 0.40), 0.16, 0.46));
    maxDelta = Math.min(maxDelta, Math.max(4, Math.min(10, Number(options.partialMaxLumaDelta ?? 9))));
    hardSceneGuard = Math.min(hardSceneGuard, Number(options.partialHardSceneGuard ?? 0.48));
    sceneAttenuation = 1.10;
  }
  if (contourBodyOverride) {
    strength = Math.min(strength, clamp(Number(options.bodyOverrideStrength ?? 0.48), 0.20, 0.56));
    maxBlend = Math.min(maxBlend, clamp(Number(options.bodyOverrideMaxBlend ?? 0.38), 0.16, 0.44));
    maxDelta = Math.min(maxDelta, Math.max(4, Math.min(10, Number(options.bodyOverrideMaxLumaDelta ?? 8))));
    hardSceneGuard = Math.min(hardSceneGuard, Number(options.bodyOverrideHardSceneGuard ?? 0.56));
    sceneAttenuation = Math.max(sceneAttenuation, 1.02);
  }

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const contour = alphaContourWeight(alphaMap, image.width, image.height, x, y, options);
      if (contour < (options.minContourWeight ?? 0.10)) continue;
      const edge = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (edge.weight >= hardSceneGuard) {
        guardedPixels++;
        continue;
      }
      const pred = prediction(image, alphaMap, x, y, options);
      if (!pred) continue;
      const current = rgbAt(image, x, y);
      const currentY = luma(current);
      const targetY = luma(pred.rgb);
      const residual = targetY - currentY;
      const residualGate = smoothstep(options.residualSoft ?? 0.55, options.residualHard ?? 3.8, Math.abs(residual));
      if (residualGate <= 0) continue;
      const agreement = 1 - smoothstep(options.spreadSoft ?? 6.5, options.spreadHard ?? 20, pred.spread);
      const endpoint = 1 - smoothstep(options.endpointSoft ?? 16, options.endpointHard ?? 48, pred.disagreement);
      const sceneWeight = clamp(1 - edge.weight * sceneAttenuation, 0, 1);
      const blend = Math.min(maxBlend, strength * contour * residualGate * agreement * endpoint * sceneWeight);
      if (blend < 0.035) continue;
      const delta = clamp(residual, -maxDelta, maxDelta) * blend;
      const p = (y * image.width + x) * 4;
      const chromaBlend = Math.min(0.10, blend * 0.18);
      for (let c = 0; c < 3; c++) {
        const lumaAdjusted = current[c] + delta;
        const chromaTarget = pred.rgb[c] - (targetY - (currentY + delta));
        data[p + c] = clampByte(lumaAdjusted + (chromaTarget - lumaAdjusted) * chromaBlend);
      }
      correctedPixels++;
      blendSum += blend;
    }
  }
  return {
    width: image.width,
    height: image.height,
    data,
    correctedPixels,
    guardedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    partialSceneProtected,
    contourBodyOverride,
    effectiveStrength: strength,
    effectiveMaxBlend: maxBlend,
    effectiveMaxLumaDelta: maxDelta,
    effectiveHardSceneGuard: hardSceneGuard
  };
}

export function applyOutlineResidualEscalation(image, alphaMap, options = {}) {
  const gate = eligibility(image, alphaMap, options);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  if (!gate.eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      outlineResidualEscalation: {
        ...gate,
        attempted: false,
        accepted: false,
        correctedPixels: 0,
        beforeGlobal,
        afterGlobal: beforeGlobal
      }
    };
  }

  const candidateOptions = {
    ...options,
    partialSceneProtected: gate.partialSceneProtected,
    contourBodyOverrideActive: gate.contourBodyOverride
  };
  const candidate = buildCandidate(image, alphaMap, candidateOptions);
  const afterOutline = measureGeometricOutlineResidual(candidate, alphaMap, {
    ...options,
    outlineMinAlpha: options.minAlpha ?? 0.018,
    outlineMaxAlpha: options.maxAlpha ?? 0.30,
    outlineResidualSoft: options.residualSoft ?? 0.55,
    outlineResidualHard: options.residualHard ?? 3.8
  });
  const afterGlobal = measurePostCleanupResidual(candidate, alphaMap);
  const improvement = gate.outline.score > 1e-6 ? (gate.outline.score - afterOutline.score) / gate.outline.score : 0;
  const conservativeMode = gate.partialSceneProtected || gate.contourBodyOverride;
  const minImprovement = gate.partialSceneProtected
    ? (options.partialMinImprovement ?? Math.min(options.minImprovement ?? 0.035, 0.020))
    : (gate.contourBodyOverride
      ? (options.bodyOverrideMinImprovement ?? Math.min(options.minImprovement ?? 0.035, 0.025))
      : (options.minImprovement ?? 0.035));
  const maxOutlineRatio = gate.partialSceneProtected
    ? (options.partialMaxOutlineRatio ?? 0.98)
    : (gate.contourBodyOverride
      ? (options.bodyOverrideMaxOutlineRatio ?? 0.975)
      : (options.maxOutlineRatio ?? 0.965));
  const maxMeanBlend = conservativeMode
    ? Number(options.conservativeMaxMeanBlend ?? 0.42)
    : Number(options.maxMeanBlend ?? 0.50);
  const accepted = candidate.correctedPixels >= (options.minCorrectedPixels ?? 6)
    && candidate.meanBlend <= maxMeanBlend
    && improvement >= minImprovement
    && afterOutline.score <= gate.outline.score * maxOutlineRatio
    && afterGlobal.total <= beforeGlobal.total * 1.005 + (options.maxTotalIncrease ?? 0.05)
    && afterGlobal.luma <= beforeGlobal.luma * 1.008 + (options.maxLumaIncrease ?? 0.05)
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.006 + (options.maxChromaIncrease ?? 0.45);

  return {
    width: image.width,
    height: image.height,
    data: accepted ? candidate.data : new Uint8ClampedArray(image.data),
    outlineResidualEscalation: {
      ...gate,
      attempted: true,
      accepted,
      beforeOutline: gate.outline,
      afterOutline: accepted ? afterOutline : gate.outline,
      candidateAfterOutline: afterOutline,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      guardedPixels: candidate.guardedPixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      effectiveStrength: candidate.effectiveStrength,
      effectiveMaxBlend: candidate.effectiveMaxBlend,
      effectiveMaxLumaDelta: candidate.effectiveMaxLumaDelta,
      effectiveHardSceneGuard: candidate.effectiveHardSceneGuard,
      conservativeMode,
      minImprovement,
      maxOutlineRatio,
      maxMeanBlend,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal
    }
  };
}

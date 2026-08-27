import { measurePostCleanupResidual } from './edgeBridge.js';
import { sceneEdgeProtectionAt } from './sceneEdgeProtection.js';
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
  const outlineDominance = outline.score / Math.max(0.35, body.score);
  return body.score <= maxBodyScore
    && body.candidateDensity <= maxBodyDensity
    && outlineDominance >= (options.minOutlineDominance ?? 0.82);
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
  const sectorSafe = outline.sectorSupport >= (options.minSectorSupport ?? 3);
  const strongOutline = outline.score >= (options.minOutlineScore ?? 1.15)
    && outline.candidateDensity >= (options.minOutlineDensity ?? 0.075)
    && outline.samples >= (options.minOutlineSamples ?? 12);
  const bodyWeak = residualBodyWeak(body, outline, options);
  const guardedRatio = outline.contourPixels > 0 ? outline.sceneGuarded / outline.contourPixels : 1;
  const sceneSafe = guardedRatio <= (options.maxSceneGuardedRatio ?? 0.34);
  return {
    eligible: options.enabled !== false && strongOutline && sectorSafe && bodyWeak && sceneSafe,
    strongOutline,
    sectorSafe,
    bodyWeak,
    sceneSafe,
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
  const strength = clamp(Number(options.strength ?? 0.58), 0.20, 0.72);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.48), 0.18, 0.56);
  const maxDelta = Math.max(4, Math.min(14, Number(options.maxLumaDelta ?? 11)));

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const contour = alphaContourWeight(alphaMap, image.width, image.height, x, y, options);
      if (contour < (options.minContourWeight ?? 0.10)) continue;
      const edge = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (edge.weight >= (options.hardSceneGuard ?? 0.62)) {
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
      const sceneWeight = 1 - edge.weight * 0.97;
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
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0
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

  const candidate = buildCandidate(image, alphaMap, options);
  const afterOutline = measureGeometricOutlineResidual(candidate, alphaMap, {
    ...options,
    outlineMinAlpha: options.minAlpha ?? 0.018,
    outlineMaxAlpha: options.maxAlpha ?? 0.30,
    outlineResidualSoft: options.residualSoft ?? 0.55,
    outlineResidualHard: options.residualHard ?? 3.8
  });
  const afterGlobal = measurePostCleanupResidual(candidate, alphaMap);
  const improvement = gate.outline.score > 1e-6 ? (gate.outline.score - afterOutline.score) / gate.outline.score : 0;
  const accepted = candidate.correctedPixels >= (options.minCorrectedPixels ?? 6)
    && improvement >= (options.minImprovement ?? 0.035)
    && afterOutline.score <= gate.outline.score * (options.maxOutlineRatio ?? 0.965)
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
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal
    }
  };
}

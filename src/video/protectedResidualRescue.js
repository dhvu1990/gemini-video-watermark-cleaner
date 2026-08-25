import { measurePostCleanupResidual } from './edgeBridge.js';
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
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
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

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2]
];

function nearestCleanAnchor(image, alphaMap, x, y, dx, dy, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.016;
  const maxRadius = Math.max(8, Math.min(36, Number(options.maxRadius ?? 28)));
  for (let distance = 2; distance <= maxRadius; distance += 1) {
    const xx = Math.round(x + dx * distance * sign);
    const yy = Math.round(y + dy * distance * sign);
    if (xx < 1 || yy < 1 || xx >= image.width - 1 || yy >= image.height - 1) break;
    if ((alphaMap[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance };
  }
  return null;
}

function directionalPrediction(image, alphaMap, x, y, dx, dy, options = {}) {
  const negative = nearestCleanAnchor(image, alphaMap, x, y, dx, dy, -1, options);
  const positive = nearestCleanAnchor(image, alphaMap, x, y, dx, dy, 1, options);
  if (!negative || !positive) return null;
  const span = negative.distance + positive.distance;
  if (span <= 0) return null;
  const negativeWeight = positive.distance / span;
  const positiveWeight = negative.distance / span;
  const rgb = [0, 1, 2].map((c) => negative.rgb[c] * negativeWeight + positive.rgb[c] * positiveWeight);
  const endpointDisagreement = Math.abs(luma(negative.rgb) - luma(positive.rgb));
  return { rgb, endpointDisagreement, span };
}

function consensusPrediction(image, alphaMap, x, y, options = {}) {
  const predictions = DIRECTIONS
    .map(([dx, dy]) => directionalPrediction(image, alphaMap, x, y, dx, dy, options))
    .filter(Boolean);
  if (predictions.length < 2) return null;
  const ycc = predictions.map((prediction) => rgbToYcbcr(prediction.rgb));
  const target = [
    median(ycc.map((value) => value[0])),
    median(ycc.map((value) => value[1])),
    median(ycc.map((value) => value[2]))
  ];
  const lumas = ycc.map((value) => value[0]);
  const spread = Math.max(...lumas) - Math.min(...lumas);
  const endpointDisagreement = median(predictions.map((prediction) => prediction.endpointDisagreement));
  return { target, spread, endpointDisagreement, directions: predictions.length };
}

export function measureProtectedResidualField(image, alphaMap, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, samples: 0, weightSum: 0, sceneGuarded: 0, candidateDensity: 0, meanPredictionSpread: 0 };
  }
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.045;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.72;
  let scoreSum = 0;
  let weightSum = 0;
  let samples = 0;
  let sceneGuarded = 0;
  let spreadSum = 0;
  let footprintPixels = 0;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      footprintPixels++;
      const prediction = consensusPrediction(image, alphaMap, x, y, options);
      if (!prediction) continue;
      const edgeGuard = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (edgeGuard.weight >= (options.hardSceneGuard ?? 0.66)) {
        sceneGuarded++;
        continue;
      }
      const current = rgbToYcbcr(rgbAt(image, x, y));
      const residual = Math.abs(current[0] - prediction.target[0]);
      const agreement = 1 - smoothstep(options.spreadSoft ?? 7, options.spreadHard ?? 22, prediction.spread);
      const endpointGuard = 1 - smoothstep(options.endpointSoft ?? 18, options.endpointHard ?? 56, prediction.endpointDisagreement);
      const alphaWeight = smoothstep(minAlpha, 0.16, alpha) * (1 - smoothstep(0.60, maxAlpha, alpha));
      const sceneWeight = 1 - edgeGuard.weight * 0.94;
      const weight = alphaWeight * agreement * endpointGuard * sceneWeight;
      if (weight < 0.035) continue;
      scoreSum += residual * weight;
      weightSum += weight;
      spreadSum += prediction.spread;
      samples++;
    }
  }
  return {
    score: weightSum ? scoreSum / weightSum : 0,
    samples,
    weightSum,
    sceneGuarded,
    candidateDensity: footprintPixels ? samples / footprintPixels : 0,
    meanPredictionSpread: samples ? spreadSum / samples : 0
  };
}

function buildRescueCandidate(image, alphaMap, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.44), 0.10, 0.62);
  const out = new Uint8ClampedArray(image.data);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.045;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.72;
  let candidatePixels = 0;
  let sceneGuardedPixels = 0;
  let meanBlendSum = 0;
  let textureImprintPixels = 0;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      const prediction = consensusPrediction(image, alphaMap, x, y, options);
      if (!prediction) continue;
      const edgeGuard = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (edgeGuard.weight >= (options.hardSceneGuard ?? 0.66)) {
        sceneGuardedPixels++;
        continue;
      }
      const currentRgb = rgbAt(image, x, y);
      const current = rgbToYcbcr(currentRgb);
      const residual = prediction.target[0] - current[0];
      const residualGate = smoothstep(options.minResidual ?? 1.0, options.fullResidual ?? 6.5, Math.abs(residual));
      if (residualGate <= 0) continue;
      const agreement = 1 - smoothstep(options.spreadSoft ?? 7, options.spreadHard ?? 22, prediction.spread);
      const endpointGuard = 1 - smoothstep(options.endpointSoft ?? 18, options.endpointHard ?? 56, prediction.endpointDisagreement);
      const alphaWeight = smoothstep(minAlpha, 0.15, alpha) * (1 - smoothstep(0.60, maxAlpha, alpha));
      const sceneWeight = 1 - edgeGuard.weight * 0.96;
      const bodyWeight = smoothstep(0.18, 0.42, alpha) * (1 - smoothstep(0.56, 0.72, alpha));
      const textureImprintBoost = 1 + bodyWeight * agreement * 0.20;
      const blend = Math.min(options.maxBlend ?? 0.38, strength * alphaWeight * agreement * endpointGuard * residualGate * sceneWeight * textureImprintBoost);
      if (blend < 0.025) continue;
      const lumaDelta = clamp(residual, -(options.maxLumaDelta ?? 10), options.maxLumaDelta ?? 10) * blend;
      const chromaBlend = Math.min(0.12, blend * 0.28);
      const cb = current[1] + clamp(prediction.target[1] - current[1], -8, 8) * chromaBlend;
      const cr = current[2] + clamp(prediction.target[2] - current[2], -8, 8) * chromaBlend;
      const rgb = ycbcrToRgb(current[0] + lumaDelta, cb, cr);
      const idx = p * 4;
      out[idx] = rgb[0]; out[idx + 1] = rgb[1]; out[idx + 2] = rgb[2];
      candidatePixels++;
      meanBlendSum += blend;
      if (bodyWeight > 0.35) textureImprintPixels++;
    }
  }
  return {
    image: { width: image.width, height: image.height, data: out },
    candidatePixels,
    sceneGuardedPixels,
    textureImprintPixels,
    meanBlend: candidatePixels ? meanBlendSum / candidatePixels : 0
  };
}

export function applyProtectedResidualRescue(image, alphaMap, options = {}) {
  const enabled = options.enabled !== false;
  const before = measureProtectedResidualField(image, alphaMap, options);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1.55;
  const minDensity = Number.isFinite(options.minDensity) ? options.minDensity : 0.16;
  const attempted = enabled && before.score >= minScore && before.candidateDensity >= minDensity && before.samples >= (options.minSamples ?? 18);
  if (!attempted) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      protectedResidualRescue: { enabled, attempted: false, accepted: false, before, after: before, beforeGlobal, afterGlobal: beforeGlobal, candidatePixels: 0, correctedPixels: 0 }
    };
  }
  const candidate = buildRescueCandidate(image, alphaMap, options);
  const after = measureProtectedResidualField(candidate.image, alphaMap, options);
  const afterGlobal = measurePostCleanupResidual(candidate.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - after.score) / before.score : 0;
  const maxChromaIncrease = Number.isFinite(options.maxChromaIncrease) ? options.maxChromaIncrease : 0.55;
  const maxTotalIncrease = Number.isFinite(options.maxTotalIncrease) ? options.maxTotalIncrease : 0.06;
  const maxLumaIncrease = Number.isFinite(options.maxLumaIncrease) ? options.maxLumaIncrease : 0.06;
  const accepted = candidate.candidatePixels > 0
    && improvement >= (options.minImprovement ?? 0.02)
    && after.score <= before.score * 0.98
    && afterGlobal.total <= beforeGlobal.total * 1.003 + maxTotalIncrease
    && afterGlobal.luma <= beforeGlobal.luma * 1.006 + maxLumaIncrease
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.004 + maxChromaIncrease;
  return {
    width: image.width,
    height: image.height,
    data: accepted ? candidate.image.data : new Uint8ClampedArray(image.data),
    protectedResidualRescue: {
      enabled,
      attempted: true,
      accepted,
      before,
      after: accepted ? after : before,
      candidateAfter: after,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateGlobalAfter: afterGlobal,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      candidatePixels: candidate.candidatePixels,
      correctedPixels: accepted ? candidate.candidatePixels : 0,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      textureImprintPixels: candidate.textureImprintPixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      maxChromaIncrease,
      maxTotalIncrease,
      maxLumaIncrease
    }
  };
}

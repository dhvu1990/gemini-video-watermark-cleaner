import { measurePostCleanupResidual } from './edgeBridge.js';
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
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
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

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2]
];

function cleanAnchor(image, guideAlpha, x, y, dx, dy, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.014;
  const maxRadius = Math.max(10, Math.min(36, Math.round(Number(options.maxRadius ?? 28))));
  for (let distance = 2; distance <= maxRadius; distance++) {
    const xx = Math.round(x + dx * distance * sign);
    const yy = Math.round(y + dy * distance * sign);
    if (xx < 1 || yy < 1 || xx >= image.width - 1 || yy >= image.height - 1) break;
    if ((guideAlpha[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance };
  }
  return null;
}

function directionalPrediction(image, guideAlpha, x, y, dx, dy, options = {}) {
  const a = cleanAnchor(image, guideAlpha, x, y, dx, dy, -1, options);
  const b = cleanAnchor(image, guideAlpha, x, y, dx, dy, 1, options);
  if (!a || !b) return null;
  const span = a.distance + b.distance;
  if (span <= 0) return null;
  const wa = b.distance / span;
  const wb = a.distance / span;
  return {
    rgb: [0, 1, 2].map((c) => a.rgb[c] * wa + b.rgb[c] * wb),
    endpointDisagreement: Math.abs(luma(a.rgb) - luma(b.rgb)),
    span
  };
}

function consensusPrediction(image, guideAlpha, x, y, options = {}) {
  const candidates = DIRECTIONS
    .map(([dx, dy]) => directionalPrediction(image, guideAlpha, x, y, dx, dy, options))
    .filter(Boolean)
    .sort((a, b) => (a.endpointDisagreement + a.span * 0.04) - (b.endpointDisagreement + b.span * 0.04));
  if (candidates.length < 2) return null;
  const selected = candidates.slice(0, Math.min(3, candidates.length));
  const ycc = selected.map((item) => rgbToYcbcr(item.rgb));
  const target = [
    median(ycc.map((value) => value[0])),
    median(ycc.map((value) => value[1])),
    median(ycc.map((value) => value[2]))
  ];
  const lumas = ycc.map((value) => value[0]);
  return {
    target,
    spread: Math.max(...lumas) - Math.min(...lumas),
    endpointDisagreement: median(selected.map((item) => item.endpointDisagreement)),
    directions: selected.length
  };
}

function residualSample(image, alphaMap, guideAlpha, x, y, options = {}) {
  const p = y * image.width + x;
  const alpha = alphaMap[p] || 0;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.12;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.78;
  if (alpha < minAlpha || alpha > maxAlpha) return null;
  const prediction = consensusPrediction(image, guideAlpha, x, y, options);
  if (!prediction) return null;
  const current = rgbToYcbcr(rgbAt(image, x, y));
  const residual = prediction.target[0] - current[0];
  const agreement = (1 - smoothstep(options.spreadSoft ?? 6, options.spreadHard ?? 20, prediction.spread))
    * (1 - smoothstep(options.endpointSoft ?? 16, options.endpointHard ?? 48, prediction.endpointDisagreement));
  return { p, alpha, prediction, current, residual, agreement };
}

export function measureInternalResidual(image, alphaMap, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, samples: 0, candidateDensity: 0, sectorSupport: 0, signConsistency: 0, highResidualPixels: 0, maxResidual: 0 };
  }
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, options.safetyBandOptions || {});
  const guideAlpha = safety.guardAlpha;
  let scoreSum = 0, weightSum = 0, samples = 0, footprint = 0, positive = 0, negative = 0;
  let highResidualPixels = 0, maxResidual = 0;
  const sectors = [0, 0, 0, 0];
  const cx = (image.width - 1) * 0.5;
  const cy = (image.height - 1) * 0.5;
  const highResidual = Number.isFinite(options.highResidual) ? options.highResidual : 8.5;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const alpha = alphaMap[y * image.width + x] || 0;
      if (alpha < (options.minAlpha ?? 0.12) || alpha > (options.maxAlpha ?? 0.78)) continue;
      footprint++;
      const sample = residualSample(image, alphaMap, guideAlpha, x, y, options);
      if (!sample || sample.agreement < 0.12) continue;
      const magnitude = Math.abs(sample.residual);
      const residualGate = smoothstep(options.residualSoft ?? 0.9, options.residualHard ?? 5.5, magnitude);
      const bodyWeight = smoothstep(options.minAlpha ?? 0.12, 0.24, sample.alpha) * (1 - smoothstep(0.68, options.maxAlpha ?? 0.78, sample.alpha));
      const weight = sample.agreement * (0.35 + bodyWeight * 0.65) * residualGate;
      if (weight < 0.025) continue;
      scoreSum += magnitude * weight;
      weightSum += weight;
      samples++;
      maxResidual = Math.max(maxResidual, magnitude);
      if (magnitude >= highResidual) highResidualPixels++;
      if (sample.residual >= 0) positive += weight; else negative += weight;
      const sector = (x >= cx ? 1 : 0) + (y >= cy ? 2 : 0);
      sectors[sector] += weight;
    }
  }
  const totalSign = positive + negative;
  const signConsistency = totalSign ? Math.max(positive, negative) / totalSign : 0;
  const meanSector = weightSum / 4;
  const sectorSupport = meanSector > 1e-9 ? sectors.filter((value) => value >= meanSector * 0.22).length : 0;
  return {
    score: weightSum ? scoreSum / weightSum : 0,
    samples,
    candidateDensity: footprint ? samples / footprint : 0,
    sectorSupport,
    signConsistency,
    highResidualPixels,
    maxResidual,
    safetyBand: { baseRadius: safety.baseRadius, tipExtraRadius: safety.tipExtraRadius }
  };
}

function buildCandidate(image, alphaMap, options = {}) {
  const safety = buildContourSafetyBand(alphaMap, image.width, image.height, options.safetyBandOptions || {});
  const guideAlpha = safety.guardAlpha;
  const out = new Uint8ClampedArray(image.data);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.12;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.78;
  const strength = clamp(Number(options.strength ?? 0.34), 0.12, 0.48);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.30), 0.10, 0.38);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 12), 4, 16);
  const highlightResidual = Number.isFinite(options.highlightResidual) ? options.highlightResidual : 9.0;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.54;
  let correctedPixels = 0, highlightPixels = 0, guardedPixels = 0, blendSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const sample = residualSample(image, alphaMap, guideAlpha, x, y, options);
      if (!sample || sample.agreement < 0.16) continue;
      const magnitude = Math.abs(sample.residual);
      const strongHighlight = magnitude >= highlightResidual
        && sample.agreement >= 0.42
        && sample.prediction.spread <= (options.highlightMaxSpread ?? 12)
        && sample.prediction.endpointDisagreement <= (options.highlightMaxEndpoint ?? 34);
      const edgeGuard = sceneEdgeProtectionAt(image, guideAlpha, x, y, options.sceneEdgeOptions || {});
      const guarded = edgeGuard.weight >= hardSceneGuard;
      if (guarded && !strongHighlight) {
        guardedPixels++;
        continue;
      }
      if (guarded && strongHighlight && edgeGuard.weight > (options.highlightHardSceneGuard ?? 0.86)) {
        guardedPixels++;
        continue;
      }

      const residualGate = smoothstep(strongHighlight ? 2.0 : (options.residualSoft ?? 0.9), strongHighlight ? 10.0 : (options.residualHard ?? 5.5), magnitude);
      const alphaWeight = smoothstep(minAlpha, 0.24, sample.alpha) * (1 - smoothstep(0.68, maxAlpha, sample.alpha));
      const sceneWeight = guarded ? 0.34 : (1 - edgeGuard.weight * 0.90);
      const highlightBoost = strongHighlight ? 1.34 : 1;
      const blend = Math.min(maxBlend + (strongHighlight ? 0.05 : 0), strength * highlightBoost * (0.38 + alphaWeight * 0.62) * sample.agreement * residualGate * sceneWeight);
      if (blend < 0.022) continue;

      const idx = sample.p * 4;
      const yDelta = clamp(sample.residual, -maxLumaDelta, maxLumaDelta) * blend;
      const chromaBlend = Math.min(strongHighlight ? 0.14 : 0.10, blend * (strongHighlight ? 0.34 : 0.26));
      const cb = sample.current[1] + clamp(sample.prediction.target[1] - sample.current[1], -10, 10) * chromaBlend;
      const cr = sample.current[2] + clamp(sample.prediction.target[2] - sample.current[2], -10, 10) * chromaBlend;
      const rgb = ycbcrToRgb(sample.current[0] + yDelta, cb, cr);
      out[idx] = rgb[0]; out[idx + 1] = rgb[1]; out[idx + 2] = rgb[2];
      correctedPixels++;
      if (strongHighlight) highlightPixels++;
      blendSum += blend;
    }
  }
  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    highlightPixels,
    guardedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0
  };
}

export function applyInternalResidualRescue(image, alphaMap, options = {}) {
  const enabled = options.enabled !== false;
  const before = measureInternalResidual(image, alphaMap, options);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const highlightTrigger = before.highResidualPixels >= (options.minHighlightPixels ?? 2)
    && before.maxResidual >= (options.minHighlightResidual ?? 9.0)
    && before.candidateDensity >= (options.minHighlightDensity ?? 0.008);
  const ghostTrigger = before.score >= (options.minScore ?? 1.30)
    && before.candidateDensity >= (options.minDensity ?? 0.045)
    && before.samples >= (options.minSamples ?? 10)
    && before.sectorSupport >= (options.minSectors ?? 2)
    && before.signConsistency >= (options.minSignConsistency ?? 0.56);
  const attempted = enabled && (highlightTrigger || ghostTrigger);
  if (!attempted) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      internalResidualRescue: { enabled, attempted: false, accepted: false, highlightTrigger, ghostTrigger, before, after: before, beforeGlobal, afterGlobal: beforeGlobal }
    };
  }

  const candidate = buildCandidate(image, alphaMap, options);
  const after = measureInternalResidual(candidate.image, alphaMap, options);
  const afterGlobal = measurePostCleanupResidual(candidate.image, alphaMap);
  const scoreImprovement = before.score > 1e-9 ? (before.score - after.score) / before.score : 0;
  const peakImprovement = before.maxResidual > 1e-9 ? (before.maxResidual - after.maxResidual) / before.maxResidual : 0;
  const highlightAccepted = highlightTrigger
    && candidate.highlightPixels > 0
    && (peakImprovement >= (options.minPeakImprovement ?? 0.06) || after.highResidualPixels < before.highResidualPixels);
  const ghostAccepted = ghostTrigger
    && scoreImprovement >= (options.minImprovement ?? 0.010)
    && after.score <= before.score * (options.maxScoreRatio ?? 0.990);
  const globalSafe = afterGlobal.total <= beforeGlobal.total * 1.004 + 0.035
    && afterGlobal.luma <= beforeGlobal.luma * 1.006 + 0.04
    && afterGlobal.chroma <= beforeGlobal.chroma * 1.006 + 0.30;
  const accepted = candidate.correctedPixels > 0
    && candidate.meanBlend <= (options.maxMeanBlend ?? 0.30)
    && (highlightAccepted || ghostAccepted)
    && globalSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? candidate.image.data : new Uint8ClampedArray(image.data),
    internalResidualRescue: {
      enabled,
      attempted: true,
      accepted,
      acceptedMode: accepted ? (highlightAccepted && ghostAccepted ? 'highlight+ghost' : (highlightAccepted ? 'highlight' : 'ghost')) : 'rejected',
      highlightTrigger,
      ghostTrigger,
      highlightAccepted: accepted && highlightAccepted,
      ghostAccepted: accepted && ghostAccepted,
      before,
      after: accepted ? after : before,
      candidateAfter: after,
      beforeGlobal,
      afterGlobal: accepted ? afterGlobal : beforeGlobal,
      candidateAfterGlobal: afterGlobal,
      scoreImprovement: accepted ? scoreImprovement : 0,
      candidateScoreImprovement: scoreImprovement,
      peakImprovement: accepted ? peakImprovement : 0,
      candidatePeakImprovement: peakImprovement,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      highlightPixels: accepted ? candidate.highlightPixels : 0,
      candidateHighlightPixels: candidate.highlightPixels,
      guardedPixels: candidate.guardedPixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      globalSafe
    }
  };
}

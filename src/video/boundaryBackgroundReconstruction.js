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
  const idx = (y * image.width + x) * 4;
  return [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
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

function localMaxAlpha(alphaMap, width, height, x, y, radius = 1) {
  let max = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      max = Math.max(max, alphaMap[yy * width + xx] || 0);
    }
  }
  return max;
}

function cleanExterior(alphaMap, width, height, x, y, cleanAlpha, safetyRadius) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false;
  const p = y * width + x;
  if ((alphaMap[p] || 0) > cleanAlpha) return false;
  return localMaxAlpha(alphaMap, width, height, x, y, safetyRadius) <= cleanAlpha * 1.25 + 0.0005;
}

function anchorAlong(image, alphaMap, x, y, dx, dy, sign, options = {}) {
  const maxRadius = Math.max(8, Math.min(40, Math.round(Number(options.maxRadius ?? 28))));
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.008;
  const safetyRadius = Math.max(0, Math.min(2, Math.round(Number(options.safetyRadius ?? 1))));
  let lastX = -1;
  let lastY = -1;
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sx = Math.round(x + dx * distance * sign);
    const sy = Math.round(y + dy * distance * sign);
    if (sx === lastX && sy === lastY) continue;
    lastX = sx;
    lastY = sy;
    if (sx < 1 || sy < 1 || sx >= image.width - 1 || sy >= image.height - 1) break;
    if (!cleanExterior(alphaMap, image.width, image.height, sx, sy, cleanAlpha, safetyRadius)) continue;
    return { x: sx, y: sy, distance: Math.hypot(sx - x, sy - y), rgb: rgbAt(image, sx, sy) };
  }
  return null;
}

function pairPrediction(image, alphaMap, x, y, dx, dy, options = {}) {
  const a = anchorAlong(image, alphaMap, x, y, dx, dy, -1, options);
  const b = anchorAlong(image, alphaMap, x, y, dx, dy, 1, options);
  if (!a || !b) return null;
  const span = a.distance + b.distance;
  if (span <= 1e-6) return null;
  const wa = b.distance / span;
  const wb = a.distance / span;
  const target = [0, 1, 2].map((channel) => a.rgb[channel] * wa + b.rgb[channel] * wb);
  const endpointGap = (
    Math.abs(a.rgb[0] - b.rgb[0])
    + Math.abs(a.rgb[1] - b.rgb[1])
    + Math.abs(a.rgb[2] - b.rgb[2])
  ) / 3;
  const lumaGap = Math.abs(luma(a.rgb) - luma(b.rgb));
  const pairSoft = Number.isFinite(options.pairSoft) ? options.pairSoft : 10;
  const pairHard = Number.isFinite(options.pairHard) ? options.pairHard : 72;
  const distanceSoft = Number.isFinite(options.distanceSoft) ? options.distanceSoft : 10;
  const distanceHard = Number.isFinite(options.distanceHard) ? options.distanceHard : 30;
  const agreement = 1 - smoothstep(pairSoft, pairHard, endpointGap * 0.70 + lumaGap * 0.30);
  const distanceQuality = 1 - smoothstep(distanceSoft, distanceHard, (a.distance + b.distance) * 0.5);
  const quality = clamp(agreement * 0.78 + distanceQuality * 0.22, 0, 1);
  return { target, targetY: luma(target), a, b, endpointGap, lumaGap, agreement, distanceQuality, quality, dx, dy };
}

function spatialConsensus(pairs, options = {}) {
  if (!pairs.length) return null;
  const usable = pairs.filter((pair) => pair.quality >= (options.minPairQuality ?? 0.18));
  if (!usable.length) return null;
  const bestPair = [...usable].sort((a, b) => (
    b.quality - a.quality
    || a.endpointGap - b.endpointGap
    || (a.a.distance + a.b.distance) - (b.a.distance + b.b.distance)
  ))[0];
  const target = [0, 1, 2].map((channel) => median(usable.map((pair) => pair.target[channel])));
  const targetY = luma(target);
  const spread = usable.reduce((sum, pair) => sum + Math.abs(pair.targetY - targetY), 0) / usable.length;
  const directionSupport = clamp((usable.length - 1) / 3, 0, 1);
  const meanQuality = usable.reduce((sum, pair) => sum + pair.quality, 0) / usable.length;
  const spreadSoft = Number.isFinite(options.spreadSoft) ? options.spreadSoft : 4;
  const spreadHard = Number.isFinite(options.spreadHard) ? options.spreadHard : 24;
  const agreement = 1 - smoothstep(spreadSoft, spreadHard, spread);
  const spatialConfidence = clamp((0.42 + directionSupport * 0.58) * meanQuality * (0.45 + agreement * 0.55), 0, 1);
  return { target, targetY, spread, agreement, meanQuality, directions: usable.length, bestPair, spatialConfidence };
}

function temporalSample(atlas, p) {
  if (!atlas?.data || !atlas?.support || !atlas?.confidence) return null;
  if (p < 0 || p >= atlas.support.length) return null;
  const minSupport = atlas.allowMaskedDonors ? 3 : 2;
  const support = atlas.support[p] || 0;
  if (support < minSupport) return null;
  const confidence = clamp(Number(atlas.confidence[p]) || 0, 0, 1);
  if (confidence < 0.18) return null;
  const supportBoost = clamp(support / Math.max(4, minSupport), 0.55, 1);
  const maskedPenalty = atlas.allowMaskedDonors ? 0.92 : 1;
  const temporalConfidence = clamp(confidence * supportBoost * maskedPenalty, 0, 1);
  const idx = p * 4;
  return {
    rgb: [atlas.data[idx], atlas.data[idx + 1], atlas.data[idx + 2]],
    confidence: temporalConfidence,
    support
  };
}

function confidenceScale(detectionConfidence) {
  const raw = Number(detectionConfidence);
  if (!Number.isFinite(raw)) return 0.72;
  const confidence = clamp(raw, 0, 1);
  if (confidence >= 0.78) return 1;
  if (confidence >= 0.65) return 0.84;
  if (confidence >= 0.50) return 0.58;
  if (confidence >= 0.40) return 0.40;
  return 0.24;
}

export function buildBackgroundConfidenceMap(image, alphaMap, atlas = null, options = {}) {
  const length = image.width * image.height;
  const spatialConfidence = new Float32Array(length);
  const structureConfidence = new Float32Array(length);
  const temporalConfidence = new Float32Array(length);
  const spatialTargets = new Float32Array(length * 3);
  const structureTargets = new Float32Array(length * 3);
  const temporalTargets = new Float32Array(length * 3);
  const directionSupport = new Uint8Array(length);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.012;
  let eligiblePixels = 0;
  let spatialPixels = 0;
  let structurePixels = 0;
  let temporalPixels = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha) continue;
      eligiblePixels++;
      const pairs = DIRECTIONS
        .map(([dx, dy]) => pairPrediction(image, alphaMap, x, y, dx, dy, options))
        .filter(Boolean);
      const consensus = spatialConsensus(pairs, options);
      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (consensus) {
        directionSupport[p] = consensus.directions;
        spatialConfidence[p] = consensus.spatialConfidence;
        const base = p * 3;
        spatialTargets[base] = consensus.target[0];
        spatialTargets[base + 1] = consensus.target[1];
        spatialTargets[base + 2] = consensus.target[2];
        spatialPixels++;

        const directionalAgreement = consensus.bestPair?.quality || 0;
        const disagreementSignal = smoothstep(
          Number.isFinite(options.structureSpreadSoft) ? options.structureSpreadSoft : 5,
          Number.isFinite(options.structureSpreadHard) ? options.structureSpreadHard : 22,
          consensus.spread
        );
        const sceneSignal = smoothstep(0.20, 0.72, scene.weight || 0);
        const structure = clamp(directionalAgreement * disagreementSignal * (0.38 + sceneSignal * 0.62), 0, 1);
        structureConfidence[p] = structure;
        if (consensus.bestPair) {
          structureTargets[base] = consensus.bestPair.target[0];
          structureTargets[base + 1] = consensus.bestPair.target[1];
          structureTargets[base + 2] = consensus.bestPair.target[2];
        }
        if (structure >= 0.16) structurePixels++;
      }

      const temporal = temporalSample(atlas, p);
      if (temporal) {
        temporalConfidence[p] = temporal.confidence;
        const base = p * 3;
        temporalTargets[base] = temporal.rgb[0];
        temporalTargets[base + 1] = temporal.rgb[1];
        temporalTargets[base + 2] = temporal.rgb[2];
        temporalPixels++;
      }
    }
  }

  return {
    spatialConfidence,
    structureConfidence,
    temporalConfidence,
    spatialTargets,
    structureTargets,
    temporalTargets,
    directionSupport,
    diagnostics: { eligiblePixels, spatialPixels, structurePixels, temporalPixels }
  };
}

function targetFromMap(map, p, sceneWeight, options = {}) {
  const base = p * 3;
  const spatial = map.spatialConfidence[p] || 0;
  const structure = map.structureConfidence[p] || 0;
  const temporal = map.temporalConfidence[p] || 0;
  const spatialTarget = [map.spatialTargets[base], map.spatialTargets[base + 1], map.spatialTargets[base + 2]];
  const structureTarget = [map.structureTargets[base], map.structureTargets[base + 1], map.structureTargets[base + 2]];
  const temporalTarget = [map.temporalTargets[base], map.temporalTargets[base + 1], map.temporalTargets[base + 2]];

  const temporalStrong = temporal >= (options.temporalPreferThreshold ?? 0.46);
  if (temporalStrong && temporal >= Math.max(spatial, structure) * 0.82) {
    if (spatial >= 0.24 && sceneWeight < 0.46) {
      const tw = temporal * 1.25;
      const sw = spatial * 0.70;
      const sum = tw + sw || 1;
      return {
        rgb: [0, 1, 2].map((channel) => (temporalTarget[channel] * tw + spatialTarget[channel] * sw) / sum),
        confidence: clamp((temporal * 0.76 + spatial * 0.24), 0, 1),
        mode: 'temporal-spatial'
      };
    }
    return { rgb: temporalTarget, confidence: temporal, mode: 'temporal' };
  }

  if (structure >= Math.max(0.18, spatial * 0.92) && sceneWeight >= 0.18) {
    if (temporal >= 0.28) {
      const tw = temporal * 1.10;
      const dw = structure * 0.90;
      const sum = tw + dw || 1;
      return {
        rgb: [0, 1, 2].map((channel) => (temporalTarget[channel] * tw + structureTarget[channel] * dw) / sum),
        confidence: clamp(temporal * 0.58 + structure * 0.42, 0, 1),
        mode: 'structure-temporal'
      };
    }
    return { rgb: structureTarget, confidence: structure, mode: 'structure-directional' };
  }

  if (spatial >= 0.16) return { rgb: spatialTarget, confidence: spatial, mode: 'spatial' };
  if (temporal >= 0.24) return { rgb: temporalTarget, confidence: temporal, mode: 'temporal-low' };
  return null;
}

export function applyBoundaryAwareBackgroundReconstruction(image, alphaMap, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height || options.enabled === false) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      backgroundReconstruction: { enabled: options.enabled !== false, attempted: false, accepted: false, reason: 'invalid-or-disabled' }
    };
  }

  const atlas = options.atlas || null;
  const map = buildBackgroundConfidenceMap(image, alphaMap, atlas, options);
  const out = new Uint8ClampedArray(image.data);
  const detectionScale = confidenceScale(options.detectionConfidence);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.012;
  const fullAlpha = Number.isFinite(options.fullAlpha) ? options.fullAlpha : 0.16;
  const maxBlend = clamp(Number(options.maxBlend ?? 0.66), 0.24, 0.82);
  const hardSceneGuard = clamp(Number(options.hardSceneGuard ?? 0.82), 0.55, 0.98);
  let correctedPixels = 0;
  let protectedPixels = 0;
  let protectedDeltaSum = 0;
  let confidenceSum = 0;
  let beforeTargetErrorSum = 0;
  let afterTargetErrorSum = 0;
  const modeCounts = {};

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha) continue;
      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      const target = targetFromMap(map, p, scene.weight || 0, options);
      if (!target) continue;
      const temporalConfidence = map.temporalConfidence[p] || 0;
      if ((scene.weight || 0) >= hardSceneGuard && temporalConfidence < 0.56 && target.mode !== 'structure-directional') continue;

      const idx = p * 4;
      const current = [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
      const difference = (
        Math.abs(current[0] - target.rgb[0])
        + Math.abs(current[1] - target.rgb[1])
        + Math.abs(current[2] - target.rgb[2])
      ) / 3;
      const residualGate = smoothstep(
        Number.isFinite(options.residualSoft) ? options.residualSoft : 0.65,
        Number.isFinite(options.residualHard) ? options.residualHard : 7.5,
        difference
      );
      if (residualGate <= 0.015) continue;

      const coreWeight = smoothstep(minAlpha, fullAlpha, alpha);
      const temporalBoost = target.mode.startsWith('temporal') || target.mode.includes('temporal') ? 1.16 : 1;
      const structureMode = target.mode.startsWith('structure');
      const sceneAttenuation = structureMode
        ? clamp(0.88 - (scene.weight || 0) * 0.18, 0.58, 0.88)
        : clamp(1 - (scene.weight || 0) * 0.78, 0.16, 1);
      const blend = Math.min(
        target.mode === 'temporal' ? Math.min(0.80, maxBlend * 1.16) : maxBlend,
        coreWeight * target.confidence * detectionScale * residualGate * temporalBoost * sceneAttenuation
      );
      if (blend < 0.035) continue;

      const currentYcc = rgbToYcbcr(current);
      const targetYcc = rgbToYcbcr(target.rgb);
      const temporalMode = target.mode.includes('temporal');
      const chromaScale = temporalMode ? 0.96 : (structureMode ? 0.82 : 0.86);
      const next = ycbcrToRgb(
        currentYcc[0] + (targetYcc[0] - currentYcc[0]) * blend,
        currentYcc[1] + (targetYcc[1] - currentYcc[1]) * blend * chromaScale,
        currentYcc[2] + (targetYcc[2] - currentYcc[2]) * blend * chromaScale
      );
      const beforeError = difference;
      const afterError = (
        Math.abs(next[0] - target.rgb[0])
        + Math.abs(next[1] - target.rgb[1])
        + Math.abs(next[2] - target.rgb[2])
      ) / 3;
      if (afterError + 0.01 >= beforeError) continue;

      out[idx] = next[0];
      out[idx + 1] = next[1];
      out[idx + 2] = next[2];
      correctedPixels++;
      confidenceSum += target.confidence;
      beforeTargetErrorSum += beforeError;
      afterTargetErrorSum += afterError;
      modeCounts[target.mode] = (modeCounts[target.mode] || 0) + 1;
      if ((scene.weight || 0) >= 0.48) {
        protectedPixels++;
        protectedDeltaSum += (
          Math.abs(next[0] - current[0])
          + Math.abs(next[1] - current[1])
          + Math.abs(next[2] - current[2])
        ) / 3;
      }
    }
  }

  const beforeResidual = measurePostCleanupResidual(image, alphaMap);
  const candidate = { width: image.width, height: image.height, data: out };
  const candidateResidual = measurePostCleanupResidual(candidate, alphaMap);
  const meanConfidence = correctedPixels ? confidenceSum / correctedPixels : 0;
  const localImprovement = beforeTargetErrorSum > 1e-9
    ? (beforeTargetErrorSum - afterTargetErrorSum) / beforeTargetErrorSum
    : 0;
  const protectedMeanDelta = protectedPixels ? protectedDeltaSum / protectedPixels : 0;
  const minCorrectedPixels = Math.max(4, Math.round(Number(options.minCorrectedPixels ?? 8)));
  const minMeanConfidence = Number.isFinite(options.minMeanConfidence) ? options.minMeanConfidence : 0.24;
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.07;
  const maxProtectedMeanDelta = Number.isFinite(options.maxProtectedMeanDelta) ? options.maxProtectedMeanDelta : 6.5;
  const residualSafe = candidateResidual.total <= beforeResidual.total * Number(options.maxTotalRatio ?? 1.035) + 0.10
    && candidateResidual.luma <= beforeResidual.luma * Number(options.maxLumaRatio ?? 1.045) + 0.14
    && candidateResidual.chroma <= beforeResidual.chroma * Number(options.maxChromaRatio ?? 1.040) + 0.40;
  const protectedSafe = protectedMeanDelta <= maxProtectedMeanDelta;
  const localSafe = correctedPixels >= minCorrectedPixels
    && meanConfidence >= minMeanConfidence
    && localImprovement >= minLocalImprovement;
  const accepted = localSafe && residualSafe && protectedSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? out : new Uint8ClampedArray(image.data),
    backgroundReconstruction: {
      enabled: true,
      attempted: correctedPixels > 0,
      accepted,
      reason: accepted ? 'boundary-aware-background-reconstruction' : (correctedPixels ? 'candidate-rejected' : 'no-confident-background-donor'),
      detectionScale,
      correctedPixels: accepted ? correctedPixels : 0,
      candidateCorrectedPixels: correctedPixels,
      meanConfidence,
      localImprovement,
      protectedPixels,
      protectedMeanDelta,
      residualSafe,
      protectedSafe,
      localSafe,
      beforeResidual,
      afterResidual: accepted ? candidateResidual : beforeResidual,
      candidateResidual,
      modeCounts,
      confidenceMapSummary: map.diagnostics,
      minCorrectedPixels,
      minMeanConfidence,
      minLocalImprovement,
      maxProtectedMeanDelta
    }
  };
}

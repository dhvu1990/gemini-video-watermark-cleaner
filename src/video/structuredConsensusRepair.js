import { buildHybridRepairMask } from './textureRepair.js';
import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from './sceneEdgeProtection.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

function findCleanAnchor(image, alphaMap, x, y, dx, dy, sign, maxRadius = 24) {
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sx = x + dx * distance * sign;
    const sy = y + dy * distance * sign;
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) break;
    const p = sy * image.width + sx;
    if ((alphaMap[p] || 0) <= 0.006) {
      const idx = p * 4;
      return {
        distance,
        rgb: [image.data[idx], image.data[idx + 1], image.data[idx + 2]]
      };
    }
  }
  return null;
}

function pairPrediction(image, alphaMap, x, y, dx, dy) {
  const negative = findCleanAnchor(image, alphaMap, x, y, dx, dy, -1);
  const positive = findCleanAnchor(image, alphaMap, x, y, dx, dy, 1);
  if (!negative || !positive) return null;
  const span = negative.distance + positive.distance;
  if (span <= 0) return null;
  const rgb = [0, 1, 2].map((c) => (
    negative.rgb[c] * positive.distance + positive.rgb[c] * negative.distance
  ) / span);
  const anchorDisagreement = (
    Math.abs(negative.rgb[0] - positive.rgb[0])
    + Math.abs(negative.rgb[1] - positive.rgb[1])
    + Math.abs(negative.rgb[2] - positive.rgb[2])
  ) / 3;
  return { rgb, anchorDisagreement, span };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function consensusPrediction(predictions) {
  if (predictions.length < 2) return null;
  const target = [0, 1, 2].map((c) => median(predictions.map((item) => item.rgb[c])));
  const distances = predictions.map((item) => (
    Math.abs(item.rgb[0] - target[0])
    + Math.abs(item.rgb[1] - target[1])
    + Math.abs(item.rgb[2] - target[2])
  ) / 3);
  const spread = median(distances);
  const anchorDisagreement = median(predictions.map((item) => item.anchorDisagreement));
  const span = median(predictions.map((item) => item.span));
  return { rgb: target, spread, anchorDisagreement, span };
}

function localStructure(image, x, y) {
  const { width, data } = image;
  const rgbAt = (xx, yy) => {
    const i = (yy * width + xx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const gx = luma(rgbAt(x + 1, y)) - luma(rgbAt(x - 1, y));
  const gy = luma(rgbAt(x, y + 1)) - luma(rgbAt(x, y - 1));
  return Math.hypot(gx, gy);
}

function applyConsensusPass(image, alphaMap, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.72), 0, 1);
  const maxSpread = Number.isFinite(options.maxSpread) ? options.maxSpread : 22;
  const hardSceneGuard = Number.isFinite(options.hardSceneGuard) ? options.hardSceneGuard : 0.58;
  const masks = buildHybridRepairMask(alphaMap, image.width, image.height);
  const out = new Uint8ClampedArray(image.data);
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  let correctedPixels = 0;
  let corePixels = 0;
  let supportSum = 0;
  let spreadSum = 0;
  let blendSum = 0;
  let sceneGuardedPixels = 0;
  let sceneProtectionSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < 0.008) continue;

      const sceneProtection = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (sceneProtection.weight >= hardSceneGuard) {
        sceneGuardedPixels++;
        continue;
      }

      const predictions = directions
        .map(([dx, dy]) => pairPrediction(image, alphaMap, x, y, dx, dy))
        .filter(Boolean);
      if (predictions.length < 2) continue;

      const consensus = consensusPrediction(predictions);
      if (!consensus) continue;
      const spreadGate = 1 - smoothstep(maxSpread * 0.55, maxSpread, consensus.spread);
      const anchorGate = 1 - smoothstep(34, 92, consensus.anchorDisagreement);
      const support = clamp((predictions.length - 1) / 3, 0, 1);
      const structureGuard = smoothstep(26, 74, localStructure(image, x, y));
      const spanGuard = smoothstep(15, 30, consensus.span);
      const sceneGate = 1 - sceneProtection.weight * 0.96;

      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const regionWeight = clamp(edge * 0.88 + feather * 0.70 + core * 0.48, 0, 1);
      const idx = p * 4;
      const residual = (
        Math.abs(consensus.rgb[0] - image.data[idx])
        + Math.abs(consensus.rgb[1] - image.data[idx + 1])
        + Math.abs(consensus.rgb[2] - image.data[idx + 2])
      ) / 3;
      const residualGate = smoothstep(2.0, 15, residual);
      const blend = Math.min(
        core > 0.45 ? 0.58 : 0.72,
        strength * regionWeight * spreadGate * anchorGate * support * residualGate
          * sceneGate * (1 - structureGuard * 0.84) * (1 - spanGuard * 0.30)
      );
      if (blend < 0.045) continue;

      for (let c = 0; c < 3; c++) {
        const delta = clamp(consensus.rgb[c] - image.data[idx + c], -36, 36);
        out[idx + c] = clampByte(image.data[idx + c] + delta * blend);
      }
      correctedPixels++;
      if (core > 0.45) corePixels++;
      supportSum += predictions.length;
      spreadSum += consensus.spread;
      blendSum += blend;
      sceneProtectionSum += sceneProtection.weight;
    }
  }

  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    corePixels,
    sceneGuardedPixels,
    meanSceneProtection: correctedPixels ? sceneProtectionSum / correctedPixels : 0,
    meanDirectionalSupport: correctedPixels ? supportSum / correctedPixels : 0,
    meanSpread: correctedPixels ? spreadSum / correctedPixels : 0,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0
  };
}

export function applyStructuredConsensusRepair(image, alphaMap, options = {}) {
  if (options.enabled === false || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      structuredConsensus: { enabled: false, attempted: false, accepted: false }
    };
  }

  const before = measurePostCleanupResidual(image, alphaMap);
  const crossingEdge = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});
  const pass = applyConsensusPass(image, alphaMap, options);
  const candidateAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.total > 1e-6 ? (before.total - candidateAfter.total) / before.total : 0;
  const requiredImprovement = crossingEdge.protect
    ? (options.crossingEdgeMinImprovement ?? 0.006)
    : (options.minImprovement ?? 0.003);
  const chromaLimit = crossingEdge.protect ? 1.002 : 1.008;
  const accepted = pass.correctedPixels > 0
    && candidateAfter.total <= before.total * 0.997
    && candidateAfter.luma <= before.luma * 1.008
    && candidateAfter.chroma <= before.chroma * chromaLimit
    && improvement >= requiredImprovement;
  const selected = accepted ? pass.image : image;

  return {
    width: selected.width,
    height: selected.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    structuredConsensus: {
      enabled: true,
      attempted: true,
      accepted,
      before,
      after: accepted ? candidateAfter : before,
      candidateAfter,
      crossingEdge,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      requiredImprovement,
      correctedPixels: accepted ? pass.correctedPixels : 0,
      candidatePixels: pass.correctedPixels,
      corePixels: accepted ? pass.corePixels : 0,
      sceneGuardedPixels: pass.sceneGuardedPixels,
      meanSceneProtection: accepted ? pass.meanSceneProtection : 0,
      meanDirectionalSupport: pass.meanDirectionalSupport,
      meanSpread: pass.meanSpread,
      meanBlend: accepted ? pass.meanBlend : 0
    }
  };
}
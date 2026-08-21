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

function cleanAnchor(image, alphaMap, x, y, dx, dy, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.012;
  const maxRadius = Math.max(8, Math.min(38, Number(options.maxRadius ?? 30)));
  for (let d = 2; d <= maxRadius; d += 1) {
    const xx = Math.round(x + dx * d * sign);
    const yy = Math.round(y + dy * d * sign);
    if (xx < 1 || yy < 1 || xx >= image.width - 1 || yy >= image.height - 1) break;
    if ((alphaMap[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance: d };
  }
  return null;
}

function directionalPrediction(image, alphaMap, x, y, dx, dy, options = {}) {
  const a = cleanAnchor(image, alphaMap, x, y, dx, dy, -1, options);
  const b = cleanAnchor(image, alphaMap, x, y, dx, dy, 1, options);
  if (!a || !b) return null;
  const span = a.distance + b.distance;
  const wa = b.distance / span;
  const wb = a.distance / span;
  const rgb = [0, 1, 2].map((c) => a.rgb[c] * wa + b.rgb[c] * wb);
  return { rgb, disagreement: Math.abs(luma(a.rgb) - luma(b.rgb)), span };
}

function consensusPrediction(image, alphaMap, x, y, options = {}) {
  const predictions = DIRECTIONS.map(([dx, dy]) => directionalPrediction(image, alphaMap, x, y, dx, dy, options)).filter(Boolean);
  if (predictions.length < 2) return null;
  const rgb = [0, 1, 2].map((c) => median(predictions.map((prediction) => prediction.rgb[c])));
  const lumas = predictions.map((prediction) => luma(prediction.rgb));
  return {
    rgb,
    luma: luma(rgb),
    spread: Math.max(...lumas) - Math.min(...lumas),
    disagreement: median(predictions.map((prediction) => prediction.disagreement)),
    directions: predictions.length
  };
}

export function measureDarkUnderflow(restored, original, alphaMap, options = {}) {
  if (!restored?.data || !original?.data || restored.width !== original.width || restored.height !== original.height || alphaMap?.length !== restored.width * restored.height) {
    return { score: 0, samples: 0, underflowPixels: 0, underflowDensity: 0, meanCollapse: 0, meanAnchorSpread: 0 };
  }
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.22;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.92;
  const blackLuma = Number.isFinite(options.blackLuma) ? options.blackLuma : 24;
  const collapseFloor = Number.isFinite(options.collapseFloor) ? options.collapseFloor : 6;
  let footprint = 0, underflowPixels = 0, collapseSum = 0, spreadSum = 0;
  for (let y = 2; y < restored.height - 2; y++) {
    for (let x = 2; x < restored.width - 2; x++) {
      const p = y * restored.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      footprint++;
      const prediction = consensusPrediction(original, alphaMap, x, y, options);
      if (!prediction) continue;
      if (prediction.spread > (options.maxPredictionSpread ?? 18) || prediction.disagreement > (options.maxAnchorDisagreement ?? 42)) continue;
      const restoredY = luma(rgbAt(restored, x, y));
      const originalY = luma(rgbAt(original, x, y));
      const collapse = prediction.luma - restoredY;
      const compositeLift = originalY - restoredY;
      if (restoredY > blackLuma || collapse < collapseFloor || compositeLift < (options.minCompositeLift ?? 8)) continue;
      underflowPixels++;
      collapseSum += collapse;
      spreadSum += prediction.spread;
    }
  }
  const density = footprint ? underflowPixels / footprint : 0;
  const meanCollapse = underflowPixels ? collapseSum / underflowPixels : 0;
  return {
    score: density * Math.min(2, meanCollapse / 12),
    samples: footprint,
    underflowPixels,
    underflowDensity: density,
    meanCollapse,
    meanAnchorSpread: underflowPixels ? spreadSum / underflowPixels : 0
  };
}

export function applyDarkUnderflowGuard(restored, original, alphaMap, options = {}) {
  const enabled = options.enabled !== false;
  const before = measureDarkUnderflow(restored, original, alphaMap, options);
  const minDensity = Number.isFinite(options.minDensity) ? options.minDensity : 0.018;
  const minPixels = Math.max(4, Number(options.minPixels ?? 6));
  const attempted = enabled && before.underflowPixels >= minPixels && before.underflowDensity >= minDensity;
  if (!attempted) {
    return {
      width: restored.width,
      height: restored.height,
      data: new Uint8ClampedArray(restored.data),
      darkUnderflowGuard: { enabled, attempted: false, accepted: false, before, after: before, correctedPixels: 0, guardedPixels: 0 }
    };
  }

  const out = new Uint8ClampedArray(restored.data);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.22;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.92;
  const blackLuma = Number.isFinite(options.blackLuma) ? options.blackLuma : 24;
  let correctedPixels = 0, guardedPixels = 0, blendSum = 0;
  for (let y = 2; y < restored.height - 2; y++) {
    for (let x = 2; x < restored.width - 2; x++) {
      const p = y * restored.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      const prediction = consensusPrediction(original, alphaMap, x, y, options);
      if (!prediction) continue;
      if (prediction.spread > (options.maxPredictionSpread ?? 18) || prediction.disagreement > (options.maxAnchorDisagreement ?? 42)) continue;
      const current = rgbAt(restored, x, y);
      const currentY = luma(current);
      const originalY = luma(rgbAt(original, x, y));
      const collapse = prediction.luma - currentY;
      if (currentY > blackLuma || collapse < (options.collapseFloor ?? 6) || originalY - currentY < (options.minCompositeLift ?? 8)) continue;

      const edgeGuard = sceneEdgeProtectionAt(restored, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (edgeGuard.weight >= (options.hardSceneGuard ?? 0.58)) {
        guardedPixels++;
        continue;
      }
      const darkTarget = smoothstep(5, 34, prediction.luma);
      const collapseWeight = smoothstep(options.collapseFloor ?? 6, options.fullCollapse ?? 24, collapse);
      const blackWeight = 1 - smoothstep(blackLuma * 0.45, blackLuma, currentY);
      const alphaWeight = smoothstep(minAlpha, 0.42, alpha) * (1 - smoothstep(0.82, maxAlpha, alpha));
      const sceneWeight = 1 - edgeGuard.weight * 0.94;
      const blend = Math.min(options.maxBlend ?? 0.78, (options.strength ?? 0.82) * darkTarget * collapseWeight * blackWeight * (0.55 + alphaWeight * 0.45) * sceneWeight);
      if (blend < 0.06) continue;
      const idx = p * 4;
      for (let c = 0; c < 3; c++) out[idx + c] = clampByte(restored.data[idx + c] * (1 - blend) + prediction.rgb[c] * blend);
      correctedPixels++;
      blendSum += blend;
    }
  }

  const candidate = { width: restored.width, height: restored.height, data: out };
  const after = measureDarkUnderflow(candidate, original, alphaMap, options);
  const improvement = before.underflowPixels > 0 ? (before.underflowPixels - after.underflowPixels) / before.underflowPixels : 0;
  const accepted = correctedPixels > 0
    && improvement >= (options.minImprovement ?? 0.30)
    && after.underflowPixels <= Math.floor(before.underflowPixels * 0.76)
    && after.meanCollapse <= before.meanCollapse * 0.90;

  return {
    width: restored.width,
    height: restored.height,
    data: accepted ? out : new Uint8ClampedArray(restored.data),
    darkUnderflowGuard: {
      enabled,
      attempted: true,
      accepted,
      before,
      after: accepted ? after : before,
      candidateAfter: after,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      correctedPixels: accepted ? correctedPixels : 0,
      candidatePixels: correctedPixels,
      guardedPixels,
      meanBlend: accepted && correctedPixels ? blendSum / correctedPixels : 0
    }
  };
}

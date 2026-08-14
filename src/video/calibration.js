import { getVideoAlphaMap } from './alpha.js';
import { applyEdgePolish, inverseAlphaRestore } from './restore.js';

const PROFILES = ['96-20260520', '96'];
const SHAPE_SCALES = [0.98, 1.0, 1.03];
const EDGE_BOOSTS = [0.03, 0.055, 0.085];
const EDGE_GAINS = [1.0, 1.15, 1.3];
const BODY_GAIN_FACTORS = [0.78, 0.88, 0.98, 1.08];

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function luma(data, idx) { return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]; }

export function scaleAlphaShape(alphaMap, size, scale = 1) {
  const safeScale = clamp(Number(scale) || 1, 0.94, 1.08);
  if (Math.abs(safeScale - 1) < 1e-6) return new Float32Array(alphaMap);
  const out = new Float32Array(alphaMap.length);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = center + (x - center) / safeScale;
      const sy = center + (y - center) / safeScale;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1, y1 = y0 + 1;
      if (x0 < 0 || y0 < 0 || x1 >= size || y1 >= size) continue;
      const fx = sx - x0, fy = sy - y0;
      const a00 = alphaMap[y0 * size + x0] || 0;
      const a10 = alphaMap[y0 * size + x1] || 0;
      const a01 = alphaMap[y1 * size + x0] || 0;
      const a11 = alphaMap[y1 * size + x1] || 0;
      out[y * size + x] = a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) + a01 * (1 - fx) * fy + a11 * fx * fy;
    }
  }
  return out;
}

export function applyEdgeGain(alphaMap, size, edgeGain = 1) {
  const gain = clamp(Number(edgeGain) || 1, 0.9, 1.45);
  if (Math.abs(gain - 1) < 1e-6) return new Float32Array(alphaMap);
  const gradient = new Float32Array(alphaMap.length);
  let maxGradient = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const p = y * size + x;
      const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gy = (alphaMap[p + size] || 0) - (alphaMap[p - size] || 0);
      gradient[p] = Math.hypot(gx, gy);
      maxGradient = Math.max(maxGradient, gradient[p]);
    }
  }
  const out = new Float32Array(alphaMap);
  for (let p = 0; p < out.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0.002) continue;
    const edge = maxGradient > 0 ? gradient[p] / maxGradient : 0;
    const lowAlpha = 1 - clamp((a - 0.08) / 0.42, 0, 1);
    const weight = clamp(edge * 0.72 + lowAlpha * 0.38, 0, 1);
    out[p] = clamp(a * (1 + (gain - 1) * weight), 0, 0.95);
  }
  return out;
}

function safeAnchor(original, alphaMap, x, y, dx, dy) {
  const { width, height, data } = original;
  for (let step = 1; step < Math.max(width, height); step++) {
    const xx = x + dx * step;
    const yy = y + dy * step;
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) break;
    const p = yy * width + xx;
    if ((alphaMap[p] || 0) <= 0.008) {
      const i = p * 4;
      return { distance: step, rgb: [data[i], data[i + 1], data[i + 2]] };
    }
  }
  return null;
}

function interpolatePair(a, b) {
  if (!a && !b) return null;
  if (!a) return b.rgb;
  if (!b) return a.rgb;
  const total = a.distance + b.distance;
  return [0, 1, 2].map((c) => (a.rgb[c] * b.distance + b.rgb[c] * a.distance) / total);
}

function predictedBackground(original, alphaMap, x, y) {
  const horizontal = interpolatePair(
    safeAnchor(original, alphaMap, x, y, -1, 0),
    safeAnchor(original, alphaMap, x, y, 1, 0)
  );
  const vertical = interpolatePair(
    safeAnchor(original, alphaMap, x, y, 0, -1),
    safeAnchor(original, alphaMap, x, y, 0, 1)
  );
  if (!horizontal) return vertical;
  if (!vertical) return horizontal;
  return [0, 1, 2].map((c) => (horizontal[c] + vertical[c]) * 0.5);
}

export function backgroundContinuityScore(original, cleaned, alphaMap) {
  const { width, height } = original;
  let maskedError = 0;
  let maskedWeight = 0;
  let outsideDamage = 0;
  let outsideWeight = 0;
  let clippingPenalty = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      const idx = p * 4;
      if (a <= 0.008) {
        const delta = (
          Math.abs(cleaned.data[idx] - original.data[idx]) +
          Math.abs(cleaned.data[idx + 1] - original.data[idx + 1]) +
          Math.abs(cleaned.data[idx + 2] - original.data[idx + 2])
        ) / 3;
        outsideDamage += delta;
        outsideWeight++;
        continue;
      }

      const predicted = predictedBackground(original, alphaMap, x, y);
      if (!predicted) continue;
      const gxA = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gyA = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const edgeWeight = clamp(Math.hypot(gxA, gyA) * 10, 0, 1);
      const alphaWeight = 0.35 + 0.65 * clamp(a / 0.42, 0, 1);
      const weight = alphaWeight * (0.8 + edgeWeight * 0.45);
      let error = 0;
      for (let c = 0; c < 3; c++) {
        const value = cleaned.data[idx + c];
        error += Math.abs(value - predicted[c]);
        if ((value <= 3 || value >= 252) && predicted[c] > 12 && predicted[c] < 243) clippingPenalty += weight;
      }
      maskedError += (error / 3) * weight;
      maskedWeight += weight;
    }
  }

  const continuity = maskedWeight ? maskedError / maskedWeight : Number.POSITIVE_INFINITY;
  const outside = outsideWeight ? outsideDamage / outsideWeight : 0;
  return continuity + outside * 2.2 + (maskedWeight ? clippingPenalty / maskedWeight * 5 : 0);
}

export function residualEdgeScore(original, cleaned, alphaMap) {
  const { width, height } = original;
  let residual = 0;
  let texturePenalty = 0;
  let residualWeight = 0;
  let textureWeight = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      const gxA = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gyA = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const edgeWeight = clamp(Math.hypot(gxA, gyA) * 9 + (a > 0.008 && a < 0.22 ? 0.35 : 0), 0, 1);
      const idx = p * 4;
      const left = (p - 1) * 4, right = (p + 1) * 4, up = (p - width) * 4, down = (p + width) * 4;
      const cleanGrad = Math.hypot(luma(cleaned.data, right) - luma(cleaned.data, left), luma(cleaned.data, down) - luma(cleaned.data, up));
      if (edgeWeight > 0.03) {
        residual += cleanGrad * edgeWeight;
        residualWeight += edgeWeight;
      }
      if (a < 0.008) {
        const delta = Math.abs(luma(cleaned.data, idx) - luma(original.data, idx));
        texturePenalty += delta;
        textureWeight++;
      }
    }
  }
  const edgeResidual = residualWeight ? residual / residualWeight : 0;
  const outsideDamage = textureWeight ? texturePenalty / textureWeight : 0;
  return edgeResidual + outsideDamage * 1.8;
}

function candidateScore(original, cleaned, alphaMap) {
  return backgroundContinuityScore(original, cleaned, alphaMap) * 0.82 + residualEdgeScore(original, cleaned, alphaMap) * 0.18;
}

export function bodyGainCandidates(estimate = 1) {
  const safeEstimate = clamp(Number(estimate) || 1, 0.55, 1.35);
  const values = [...BODY_GAIN_FACTORS.map((factor) => safeEstimate * factor), 1];
  return [...new Set(values.map((value) => clamp(value, 0.55, 1.35).toFixed(4)))].map(Number).sort((a, b) => a - b);
}

export async function buildCalibratedAlphaMap(size, calibration = {}) {
  const profile = calibration.profile || '96-20260520';
  const shapeScale = Number.isFinite(calibration.shapeScale) ? calibration.shapeScale : 1;
  const edgeBoost = Number.isFinite(calibration.edgeBoost) ? calibration.edgeBoost : 0.055;
  const edgeGain = Number.isFinite(calibration.edgeGain) ? calibration.edgeGain : 1;
  const base = await getVideoAlphaMap(size, profile, edgeBoost);
  const shaped = scaleAlphaShape(base, size, shapeScale);
  return applyEdgeGain(shaped, size, edgeGain);
}

function scoreSamples(samples, alphaMap, bodyGain, edgePolish, polish = true) {
  let score = 0;
  for (const roi of samples) {
    let cleaned = inverseAlphaRestore(roi, alphaMap, bodyGain);
    if (polish) cleaned = applyEdgePolish(cleaned, alphaMap, edgePolish);
    score += candidateScore(roi, cleaned, alphaMap);
  }
  return score / samples.length;
}

export async function calibrateAlphaShape({ rois, size, bodyGain = 1, edgePolish = 0.35, onProgress }) {
  const samples = (rois || []).filter(Boolean).slice(0, 3);
  if (!samples.length) return null;

  const initialBodyGain = clamp(Number(bodyGain) || 1, 0.55, 1.35);
  const baselineMap = await buildCalibratedAlphaMap(size, {
    profile: '96-20260520', shapeScale: 1, edgeBoost: 0.03, edgeGain: 1
  });
  const baselineScore = scoreSamples(samples, baselineMap, initialBodyGain, edgePolish, true);

  let selectedBodyGain = initialBodyGain;
  let selectedBodyScore = Number.POSITIVE_INFINITY;
  for (const gain of bodyGainCandidates(initialBodyGain)) {
    const score = scoreSamples(samples, baselineMap, gain, 0, false);
    if (score < selectedBodyScore) {
      selectedBodyScore = score;
      selectedBodyGain = gain;
    }
  }

  let best = {
    profile: '96-20260520',
    shapeScale: 1,
    edgeBoost: 0.03,
    edgeGain: 1,
    bodyGain: selectedBodyGain,
    residualScore: scoreSamples(samples, baselineMap, selectedBodyGain, edgePolish, true),
    alphaMap: baselineMap
  };

  let index = 0;
  const total = PROFILES.length * SHAPE_SCALES.length * EDGE_BOOSTS.length * EDGE_GAINS.length;
  for (const profile of PROFILES) {
    for (const shapeScale of SHAPE_SCALES) {
      for (const edgeBoost of EDGE_BOOSTS) {
        for (const edgeGain of EDGE_GAINS) {
          index++;
          const alphaMap = await buildCalibratedAlphaMap(size, { profile, shapeScale, edgeBoost, edgeGain });
          const score = scoreSamples(samples, alphaMap, selectedBodyGain, edgePolish, true);
          if (score < best.residualScore) {
            best = { profile, shapeScale, edgeBoost, edgeGain, bodyGain: selectedBodyGain, residualScore: score, alphaMap };
          }
          if (index % 6 === 0) onProgress?.({ index, total, progress: index / total });
        }
      }
    }
  }

  best.initialBodyGain = initialBodyGain;
  best.baselineScore = baselineScore;
  best.bodyOnlyScore = selectedBodyScore;
  best.improvement = baselineScore > 0 ? clamp((baselineScore - best.residualScore) / baselineScore, -1, 1) : 0;
  return best;
}

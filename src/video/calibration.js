import { getVideoAlphaMap } from './alpha.js';
import { applyEdgePolish, inverseAlphaRestore } from './restore.js';

const PROFILES = ['96-20260520', '96'];
const SHAPE_SCALES = [0.98, 1.0, 1.03];
const EDGE_BOOSTS = [0.03, 0.055, 0.085];
const EDGE_GAINS = [1.0, 1.15, 1.3];

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

async function candidateMap(size, profile, shapeScale, edgeBoost, edgeGain) {
  const base = await getVideoAlphaMap(size, profile, edgeBoost);
  const shaped = scaleAlphaShape(base, size, shapeScale);
  return applyEdgeGain(shaped, size, edgeGain);
}

export async function calibrateAlphaShape({ rois, size, bodyGain = 1, edgePolish = 0.35, onProgress }) {
  const samples = (rois || []).filter(Boolean).slice(0, 3);
  if (!samples.length) return null;
  let best = null;
  let index = 0;
  const total = PROFILES.length * SHAPE_SCALES.length * EDGE_BOOSTS.length * EDGE_GAINS.length;

  for (const profile of PROFILES) {
    for (const shapeScale of SHAPE_SCALES) {
      for (const edgeBoost of EDGE_BOOSTS) {
        for (const edgeGain of EDGE_GAINS) {
          index++;
          const alphaMap = await candidateMap(size, profile, shapeScale, edgeBoost, edgeGain);
          let score = 0;
          for (const roi of samples) {
            let cleaned = inverseAlphaRestore(roi, alphaMap, bodyGain);
            cleaned = applyEdgePolish(cleaned, alphaMap, edgePolish);
            score += residualEdgeScore(roi, cleaned, alphaMap);
          }
          score /= samples.length;
          if (!best || score < best.residualScore) {
            best = { profile, shapeScale, edgeBoost, edgeGain, bodyGain, residualScore: score, alphaMap };
          }
          if (index % 6 === 0) onProgress?.({ index, total, progress: index / total });
        }
      }
    }
  }
  return best;
}

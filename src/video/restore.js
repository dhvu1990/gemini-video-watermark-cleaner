import { enhanceAlphaEdges } from './alpha.js';

function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function luma(data, idx) { return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]; }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function inverseAlphaRestore(roi, alphaMap, gain = 1) {
  const out = new Uint8ClampedArray(roi.data);
  const pixels = roi.width * roi.height;
  for (let p = 0; p < pixels; p++) {
    const rawAlpha = alphaMap[p] || 0;
    if (rawAlpha <= 0.002) continue;
    const alpha = clamp(rawAlpha * gain, 0, 0.99);
    if (alpha <= 0.002) continue;
    const idx = p * 4;
    const inv = 1 - alpha;
    out[idx] = clampByte((roi.data[idx] - alpha * 255) / inv);
    out[idx + 1] = clampByte((roi.data[idx + 1] - alpha * 255) / inv);
    out[idx + 2] = clampByte((roi.data[idx + 2] - alpha * 255) / inv);
  }
  return { width: roi.width, height: roi.height, data: out };
}

function alphaEdgeMap(alphaMap, width, height) {
  const out = new Float32Array(alphaMap.length);
  let max = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = alphaMap[i + 1] - alphaMap[i - 1];
      const gy = alphaMap[i + width] - alphaMap[i - width];
      const g = Math.hypot(gx, gy);
      out[i] = g;
      if (g > max) max = g;
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

export function applyResidualFootprintCleanup(imageData, alphaMap, strength = 0.65) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0) return imageData;
  const { width, height, data } = imageData;
  const edge = alphaEdgeMap(alphaMap, width, height);
  const out = new Uint8ClampedArray(data);

  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      let localMax = a;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          localMax = Math.max(localMax, alphaMap[(y + dy) * width + x + dx] || 0);
        }
      }
      if (localMax < 0.012) continue;

      const idx = p * 4;
      const gx = luma(data, (y * width + x + 1) * 4) - luma(data, (y * width + x - 1) * 4);
      const gy = luma(data, ((y + 1) * width + x) * 4) - luma(data, ((y - 1) * width + x) * 4);
      const structureGuard = smoothstep(24, 92, Math.hypot(gx, gy));
      const edgeBand = clamp(
        edge[p] * 0.65 + smoothstep(0.012, 0.12, localMax) * (1 - smoothstep(0.10, 0.34, a)) * 0.7,
        0,
        1
      );
      const mask = edgeBand * safeStrength * (1 - structureGuard * 0.72);
      if (mask < 0.05) continue;

      const sums = [0, 0, 0];
      let weightSum = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (dx === 0 && dy === 0) continue;
          const np = (y + dy) * width + x + dx;
          const na = alphaMap[np] || 0;
          const lowAlpha = 1 - smoothstep(0.01, 0.18, na);
          const dist2 = dx * dx + dy * dy;
          const spatial = Math.exp(-dist2 / 8);
          const w = spatial * (0.12 + lowAlpha * 0.88);
          const ni = np * 4;
          sums[0] += data[ni] * w;
          sums[1] += data[ni + 1] * w;
          sums[2] += data[ni + 2] * w;
          weightSum += w;
        }
      }
      if (weightSum <= 0) continue;
      const blend = Math.min(0.58, mask * 0.58);
      for (let c = 0; c < 3; c++) {
        out[idx + c] = clampByte(data[idx + c] * (1 - blend) + sums[c] / weightSum * blend);
      }
    }
  }
  return { width, height, data: out };
}

export function applyEdgePolish(imageData, alphaMap, strength = 0.35) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0) return imageData;
  const { width, height, data } = imageData;
  const cleanupAlpha = width >= 40 && width === height ? enhanceAlphaEdges(alphaMap, width, 0.045) : new Float32Array(alphaMap);
  const edge = alphaEdgeMap(cleanupAlpha, width, height);
  const out = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const mask = edge[p] * safeStrength;
      if (mask < 0.05 || (cleanupAlpha[p] || 0) < 0.01) continue;
      const idx = p * 4;
      const centerLuma = luma(data, idx);
      const sums = [0, 0, 0];
      let weightSum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const np = (y + dy) * width + x + dx;
          const ni = np * 4;
          const delta = Math.abs(luma(data, ni) - centerLuma);
          const colorWeight = Math.exp(-(delta * delta) / (2 * 28 * 28));
          const spatial = dx === 0 && dy === 0 ? 1.5 : (dx === 0 || dy === 0 ? 1 : 0.7);
          const w = colorWeight * spatial;
          sums[0] += data[ni] * w;
          sums[1] += data[ni + 1] * w;
          sums[2] += data[ni + 2] * w;
          weightSum += w;
        }
      }
      if (weightSum <= 0) continue;
      const blend = Math.min(0.34, mask * 0.28);
      for (let c = 0; c < 3; c++) {
        out[idx + c] = clampByte(data[idx + c] * (1 - blend) + sums[c] / weightSum * blend);
      }
    }
  }

  const polished = { width, height, data: out };
  return applyResidualFootprintCleanup(polished, cleanupAlpha, Math.min(0.85, 0.45 + safeStrength * 0.55));
}

export function stabilizeCorrection(original, processed, previous, alphaMap, strength = 0.7) {
  if (!previous?.original || !previous?.processed) return processed;
  if (previous.original.width !== original.width || previous.original.height !== original.height) return processed;
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  const out = new Uint8ClampedArray(processed.data);
  for (let p = 0; p < alphaMap.length; p++) {
    const alpha = alphaMap[p] || 0;
    if (alpha < 0.025) continue;
    const idx = p * 4;
    const motion = Math.abs(luma(original.data, idx) - luma(previous.original.data, idx));
    if (motion > 18) continue;
    const motionGate = 1 - clamp((motion - 3) / 15, 0, 1);
    const alphaGate = clamp((alpha - 0.025) / 0.22, 0, 1);
    const blend = Math.min(0.22, safeStrength * motionGate * alphaGate * 0.22);
    if (blend <= 0.01) continue;
    for (let c = 0; c < 3; c++) {
      const currentDelta = processed.data[idx + c] - original.data[idx + c];
      const previousDelta = previous.processed.data[idx + c] - previous.original.data[idx + c];
      out[idx + c] = clampByte(original.data[idx + c] + currentDelta * (1 - blend) + previousDelta * blend);
    }
  }
  return { width: processed.width, height: processed.height, data: out };
}

export function toImageDataLike(value) {
  if (typeof ImageData !== 'undefined' && !(value instanceof ImageData)) return new ImageData(value.data, value.width, value.height);
  return value;
}

import { buildHybridRepairMask } from './textureRepair.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function bilinearScalar(values, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = values[y0 * width + x0] || 0;
  const v10 = values[y0 * width + x1] || 0;
  const v01 = values[y1 * width + x0] || 0;
  const v11 = values[y1 * width + x1] || 0;
  return v00 * (1 - fx) * (1 - fy)
    + v10 * fx * (1 - fy)
    + v01 * (1 - fx) * fy
    + v11 * fx * fy;
}

function bilinearRgb(image, x, y) {
  const { width, height, data } = image;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const sample = (xx, yy, c) => data[(yy * width + xx) * 4 + c];
  return [0, 1, 2].map((c) => (
    sample(x0, y0, c) * (1 - fx) * (1 - fy)
    + sample(x1, y0, c) * fx * (1 - fy)
    + sample(x0, y1, c) * (1 - fx) * fy
    + sample(x1, y1, c) * fx * fy
  ));
}

function gradientAt(alphaMap, width, x, y) {
  const p = y * width + x;
  const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
  const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
  const magnitude = Math.hypot(gx, gy);
  return { gx, gy, magnitude };
}

function findOuterAnchor(image, alphaMap, x, y, nx, ny, maxRadius = 8) {
  for (let distance = 0.75; distance <= maxRadius; distance += 0.75) {
    const sx = x - nx * distance;
    const sy = y - ny * distance;
    const alpha = bilinearScalar(alphaMap, image.width, image.height, sx, sy);
    if (alpha === null) break;
    if (alpha <= 0.008) {
      const rgb = bilinearRgb(image, sx, sy);
      if (rgb) return { distance, rgb };
    }
  }
  return null;
}

function findInnerAnchor(image, alphaMap, masks, x, y, nx, ny, currentAlpha, maxRadius = 8) {
  const minInnerAlpha = Math.max(0.10, currentAlpha + 0.035);
  for (let distance = 0.75; distance <= maxRadius; distance += 0.75) {
    const sx = x + nx * distance;
    const sy = y + ny * distance;
    const alpha = bilinearScalar(alphaMap, image.width, image.height, sx, sy);
    const core = bilinearScalar(masks.core, image.width, image.height, sx, sy);
    const edge = bilinearScalar(masks.edge, image.width, image.height, sx, sy);
    if (alpha === null || core === null || edge === null) break;
    if (alpha >= minInnerAlpha && (core >= 0.16 || edge <= 0.28)) {
      const rgb = bilinearRgb(image, sx, sy);
      if (rgb) return { distance, rgb };
    }
  }
  return null;
}

function bridgePrediction(outer, inner) {
  const total = outer.distance + inner.distance;
  if (total <= 0) return null;
  const outerWeight = inner.distance / total;
  const innerWeight = outer.distance / total;
  return [0, 1, 2].map((c) => outer.rgb[c] * outerWeight + inner.rgb[c] * innerWeight);
}

export function applyMicroEdgeFinish(image, alphaMap, strength = 0.48) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || alphaMap.length !== image.width * image.height) return image;

  const { width, height, data } = image;
  const masks = buildHybridRepairMask(alphaMap, width, height);
  const out = new Uint8ClampedArray(data);
  let finishingPixels = 0;
  let blendSum = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ringWeight = clamp(edge * 1.08 + feather * 0.18 - core * 0.95, 0, 1);
      if (alpha < 0.006 || ringWeight < 0.24 || core > 0.46) continue;

      const gradient = gradientAt(alphaMap, width, x, y);
      if (gradient.magnitude < 0.0018) continue;
      const nx = gradient.gx / gradient.magnitude;
      const ny = gradient.gy / gradient.magnitude;
      const outer = findOuterAnchor(image, alphaMap, x, y, nx, ny, 6.5);
      const inner = findInnerAnchor(image, alphaMap, masks, x, y, nx, ny, alpha, 6.5);
      if (!outer || !inner) continue;

      const predicted = bridgePrediction(outer, inner);
      if (!predicted) continue;
      const anchorDelta = (
        Math.abs(outer.rgb[0] - inner.rgb[0])
        + Math.abs(outer.rgb[1] - inner.rgb[1])
        + Math.abs(outer.rgb[2] - inner.rgb[2])
      ) / 3;
      const structureGuard = smoothstep(26, 88, anchorDelta);
      const span = outer.distance + inner.distance;
      const spanGuard = smoothstep(5.5, 11, span);
      const idx = p * 4;
      const residual = (
        Math.abs(predicted[0] - data[idx])
        + Math.abs(predicted[1] - data[idx + 1])
        + Math.abs(predicted[2] - data[idx + 2])
      ) / 3;
      const residualGate = smoothstep(2.5, 16, residual);
      const blend = Math.min(
        0.52,
        safeStrength * ringWeight * residualGate * (1 - structureGuard * 0.86) * (1 - spanGuard * 0.42)
      );
      if (blend < 0.045) continue;

      for (let c = 0; c < 3; c++) {
        const delta = clamp(predicted[c] - data[idx + c], -32, 32);
        out[idx + c] = clampByte(data[idx + c] + delta * blend);
      }
      finishingPixels++;
      blendSum += blend;
    }
  }

  return {
    width,
    height,
    data: out,
    edgeFinish: {
      finishingPixels,
      meanBlend: finishingPixels ? blendSum / finishingPixels : 0
    }
  };
}

export function applyNormalEdgeBridge(image, alphaMap, strength = 0.90) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || alphaMap.length !== image.width * image.height) return image;

  const { width, height, data } = image;
  const masks = buildHybridRepairMask(alphaMap, width, height);
  const out = new Uint8ClampedArray(data);
  let bridgedPixels = 0;
  let blendSum = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ringWeight = clamp(edge * 0.96 + feather * 0.34 - core * 0.72, 0, 1);
      if (alpha < 0.008 || ringWeight < 0.16 || core > 0.62) continue;

      const gradient = gradientAt(alphaMap, width, x, y);
      if (gradient.magnitude < 0.0015) continue;
      const nx = gradient.gx / gradient.magnitude;
      const ny = gradient.gy / gradient.magnitude;
      const outer = findOuterAnchor(image, alphaMap, x, y, nx, ny);
      const inner = findInnerAnchor(image, alphaMap, masks, x, y, nx, ny, alpha);
      if (!outer || !inner) continue;

      const predicted = bridgePrediction(outer, inner);
      if (!predicted) continue;
      const anchorDelta = (
        Math.abs(outer.rgb[0] - inner.rgb[0])
        + Math.abs(outer.rgb[1] - inner.rgb[1])
        + Math.abs(outer.rgb[2] - inner.rgb[2])
      ) / 3;
      const structureGuard = smoothstep(34, 112, anchorDelta);
      const shortSpanBoost = 1 - smoothstep(5.5, 12, outer.distance + inner.distance);
      const blend = Math.min(
        0.92,
        safeStrength * ringWeight * (0.76 + shortSpanBoost * 0.24) * (1 - structureGuard * 0.78)
      );
      if (blend < 0.08) continue;

      const idx = p * 4;
      for (let c = 0; c < 3; c++) {
        const delta = clamp(predicted[c] - data[idx + c], -68, 68);
        out[idx + c] = clampByte(data[idx + c] + delta * blend);
      }
      bridgedPixels++;
      blendSum += blend;
    }
  }

  const bridged = { width, height, data: out };
  const finished = applyMicroEdgeFinish(bridged, alphaMap, 0.48);
  return {
    width,
    height,
    data: finished.data,
    edgeBridge: {
      bridgedPixels,
      meanBlend: bridgedPixels ? blendSum / bridgedPixels : 0,
      finishingPixels: finished.edgeFinish?.finishingPixels || 0,
      finishingMeanBlend: finished.edgeFinish?.meanBlend || 0
    }
  };
}

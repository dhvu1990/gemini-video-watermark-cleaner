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

function rgbToYcbcr(rgb) {
  const [r, g, b] = rgb;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const cb = (b - y) * 0.5389;
  const cr = (r - y) * 0.6350;
  return [y, cb, cr];
}

function ycbcrToRgb(y, cb, cr) {
  const r = y + cr / 0.6350;
  const b = y + cb / 0.5389;
  const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return [clampByte(r), clampByte(g), clampByte(b)];
}

function quadrantOf(x, y, width, height) {
  const horizontal = x < width / 2 ? 'left' : 'right';
  const vertical = y < height / 2 ? 'top' : 'bottom';
  return `${vertical}-${horizontal}`;
}

export function measurePostCleanupResidual(image, alphaMap) {
  const { width, height, data } = image;
  const masks = buildHybridRepairMask(alphaMap, width, height);
  const names = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const quadrants = Object.fromEntries(names.map((name) => [name, { luma: 0, chroma: 0, weight: 0, samples: 0 }]));
  let lumaSum = 0;
  let chromaSum = 0;
  let weightSum = 0;
  let samples = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ringWeight = clamp(edge * 1.04 + feather * 0.22 - core * 0.92, 0, 1);
      if (alpha < 0.006 || ringWeight < 0.18 || core > 0.50) continue;
      const gradient = gradientAt(alphaMap, width, x, y);
      if (gradient.magnitude < 0.0015) continue;
      const nx = gradient.gx / gradient.magnitude;
      const ny = gradient.gy / gradient.magnitude;
      const outer = findOuterAnchor(image, alphaMap, x, y, nx, ny, 6.5);
      const inner = findInnerAnchor(image, alphaMap, masks, x, y, nx, ny, alpha, 6.5);
      if (!outer || !inner) continue;
      const predicted = bridgePrediction(outer, inner);
      if (!predicted) continue;

      const idx = p * 4;
      const current = rgbToYcbcr([data[idx], data[idx + 1], data[idx + 2]]);
      const target = rgbToYcbcr(predicted);
      const lumaResidual = Math.abs(current[0] - target[0]);
      const chromaResidual = (Math.abs(current[1] - target[1]) + Math.abs(current[2] - target[2])) * 0.5;
      const weight = ringWeight * (0.65 + Math.min(0.35, gradient.magnitude * 5));
      lumaSum += lumaResidual * weight;
      chromaSum += chromaResidual * weight;
      weightSum += weight;
      samples++;

      const name = quadrantOf(x, y, width, height);
      const q = quadrants[name];
      q.luma += lumaResidual * weight;
      q.chroma += chromaResidual * weight;
      q.weight += weight;
      q.samples++;
    }
  }

  const normalizedQuadrants = {};
  for (const name of names) {
    const q = quadrants[name];
    normalizedQuadrants[name] = {
      luma: q.weight ? q.luma / q.weight : 0,
      chroma: q.weight ? q.chroma / q.weight : 0,
      total: q.weight ? (q.luma * 0.38 + q.chroma * 0.62) / q.weight : 0,
      samples: q.samples
    };
  }
  const luma = weightSum ? lumaSum / weightSum : 0;
  const chroma = weightSum ? chromaSum / weightSum : 0;
  return {
    luma,
    chroma,
    total: luma * 0.38 + chroma * 0.62,
    samples,
    quadrants: normalizedQuadrants
  };
}

export function applyAdaptiveQuadrantChromaFinish(image, alphaMap, diagnostics = null, strength = 0.55) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || alphaMap.length !== image.width * image.height) return image;
  const residual = diagnostics || measurePostCleanupResidual(image, alphaMap);
  const { width, height, data } = image;
  const masks = buildHybridRepairMask(alphaMap, width, height);
  const out = new Uint8ClampedArray(data);
  const quadrantTotals = Object.values(residual.quadrants || {}).map((q) => q.total).filter(Number.isFinite);
  const meanQuadrant = quadrantTotals.length ? quadrantTotals.reduce((a, b) => a + b, 0) / quadrantTotals.length : residual.total;
  let correctedPixels = 0;
  let blendSum = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ringWeight = clamp(edge * 1.10 + feather * 0.18 - core * 1.00, 0, 1);
      if (alpha < 0.006 || ringWeight < 0.25 || core > 0.42) continue;

      const gradient = gradientAt(alphaMap, width, x, y);
      if (gradient.magnitude < 0.0018) continue;
      const nx = gradient.gx / gradient.magnitude;
      const ny = gradient.gy / gradient.magnitude;
      const outer = findOuterAnchor(image, alphaMap, x, y, nx, ny, 6.0);
      const inner = findInnerAnchor(image, alphaMap, masks, x, y, nx, ny, alpha, 6.0);
      if (!outer || !inner) continue;
      const predicted = bridgePrediction(outer, inner);
      if (!predicted) continue;

      const anchorDelta = (
        Math.abs(outer.rgb[0] - inner.rgb[0])
        + Math.abs(outer.rgb[1] - inner.rgb[1])
        + Math.abs(outer.rgb[2] - inner.rgb[2])
      ) / 3;
      const structureGuard = smoothstep(24, 82, anchorDelta);
      const q = residual.quadrants?.[quadrantOf(x, y, width, height)] || { total: residual.total };
      const quadrantBoost = clamp(0.72 + (q.total - meanQuadrant) / Math.max(8, meanQuadrant) * 0.38, 0.55, 1.18);
      const idx = p * 4;
      const currentYcc = rgbToYcbcr([data[idx], data[idx + 1], data[idx + 2]]);
      const targetYcc = rgbToYcbcr(predicted);
      const chromaResidual = (Math.abs(currentYcc[1] - targetYcc[1]) + Math.abs(currentYcc[2] - targetYcc[2])) * 0.5;
      const residualGate = smoothstep(1.4, 11, chromaResidual);
      const baseBlend = safeStrength * ringWeight * quadrantBoost * residualGate * (1 - structureGuard * 0.90);
      if (baseBlend < 0.035) continue;

      const lumaBlend = Math.min(0.18, baseBlend * 0.24);
      const chromaBlend = Math.min(0.62, baseBlend * 0.82);
      const yValue = currentYcc[0] + clamp(targetYcc[0] - currentYcc[0], -14, 14) * lumaBlend;
      const cbValue = currentYcc[1] + clamp(targetYcc[1] - currentYcc[1], -24, 24) * chromaBlend;
      const crValue = currentYcc[2] + clamp(targetYcc[2] - currentYcc[2], -24, 24) * chromaBlend;
      const rgb = ycbcrToRgb(yValue, cbValue, crValue);
      out[idx] = rgb[0];
      out[idx + 1] = rgb[1];
      out[idx + 2] = rgb[2];
      correctedPixels++;
      blendSum += chromaBlend;
    }
  }

  return {
    width,
    height,
    data: out,
    quadrantFinish: {
      correctedPixels,
      meanChromaBlend: correctedPixels ? blendSum / correctedPixels : 0
    }
  };
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
  const residualBefore = measurePostCleanupResidual(finished, alphaMap);
  const adaptive = applyAdaptiveQuadrantChromaFinish(finished, alphaMap, residualBefore, 0.55);
  const residualAfter = measurePostCleanupResidual(adaptive, alphaMap);
  const improvement = residualBefore.total > 0
    ? clamp((residualBefore.total - residualAfter.total) / residualBefore.total, -1, 1)
    : 0;

  return {
    width,
    height,
    data: adaptive.data,
    edgeBridge: {
      bridgedPixels,
      meanBlend: bridgedPixels ? blendSum / bridgedPixels : 0,
      finishingPixels: finished.edgeFinish?.finishingPixels || 0,
      finishingMeanBlend: finished.edgeFinish?.meanBlend || 0,
      quadrantPixels: adaptive.quadrantFinish?.correctedPixels || 0,
      quadrantMeanChromaBlend: adaptive.quadrantFinish?.meanChromaBlend || 0,
      finalResidualBefore: residualBefore,
      finalResidualAfter: residualAfter,
      finalResidualImprovement: improvement
    }
  };
}

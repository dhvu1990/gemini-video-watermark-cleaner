function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function lumaAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}
function lowPassLuma(image, radius = 1) {
  const { width, height } = image;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let weight = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = clamp(y + dy, 0, height - 1);
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = clamp(x + dx, 0, width - 1);
          const w = (radius + 1 - Math.abs(dx)) * (radius + 1 - Math.abs(dy));
          sum += lumaAt(image, xx, yy) * w;
          weight += w;
        }
      }
      out[y * width + x] = weight ? sum / weight : lumaAt(image, x, y);
    }
  }
  return out;
}
function gradient(values, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const gx = (values[y * width + x + 1] - values[y * width + x - 1]) * 0.5;
  const gy = (values[(y + 1) * width + x] - values[(y - 1) * width + x]) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}
function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const gx = ((alphaMap[y * width + x + 1] || 0) - (alphaMap[y * width + x - 1] || 0)) * 0.5;
  const gy = ((alphaMap[(y + 1) * width + x] || 0) - (alphaMap[(y - 1) * width + x] || 0)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}
function cosineAbs(a, b) {
  if (a.magnitude < 1e-6 || b.magnitude < 1e-6) return 0;
  return Math.abs((a.gx * b.gx + a.gy * b.gy) / (a.magnitude * b.magnitude));
}
function maxAlphaAround(alphaMap, width, height, x, y, radius) {
  let best = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      best = Math.max(best, alphaMap[yy * width + xx] || 0);
    }
  }
  return best;
}
function nearestAlphaGradient(alphaMap, width, height, x, y, radius = 4) {
  let best = { gx: 0, gy: 0, magnitude: 0 };
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 1 || yy >= height - 1) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 1 || xx >= width - 1) continue;
      const candidate = alphaGradient(alphaMap, width, height, xx, yy);
      if (candidate.magnitude > best.magnitude) best = candidate;
    }
  }
  return best;
}
function straddlesMask(alphaMap, width, height, x, y, edge, options) {
  if (edge.magnitude < 1e-6) return false;
  const nx = edge.gx / edge.magnitude;
  const ny = edge.gy / edge.magnitude;
  const insideMinAlpha = Number.isFinite(options.insideMinAlpha) ? options.insideMinAlpha : 0.04;
  const outsideMaxAlpha = Number.isFinite(options.outsideMaxAlpha) ? options.outsideMaxAlpha : 0.018;
  const probeDistance = Math.max(2, Math.min(5, Math.round(options.probeDistance ?? 4)));
  let positiveMax = 0;
  let negativeMax = 0;
  let positiveMin = 1;
  let negativeMin = 1;
  for (let distance = 1; distance <= probeDistance; distance++) {
    for (const sign of [-1, 1]) {
      const sx = Math.round(x + nx * distance * sign);
      const sy = Math.round(y + ny * distance * sign);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const alpha = alphaMap[sy * width + sx] || 0;
      if (sign > 0) {
        positiveMax = Math.max(positiveMax, alpha);
        positiveMin = Math.min(positiveMin, alpha);
      } else {
        negativeMax = Math.max(negativeMax, alpha);
        negativeMin = Math.min(negativeMin, alpha);
      }
    }
  }
  return (positiveMax >= insideMinAlpha && negativeMin <= outsideMaxAlpha)
    || (negativeMax >= insideMinAlpha && positiveMin <= outsideMaxAlpha);
}

export const HIGH_CONTRAST_ADJACENCY_THRESHOLDS = Object.freeze({
  high: Object.freeze({ score: 0.52, edgeDensity: 0.055, straddleDensity: 0.012, meanContrast: 5.5 }),
  medium: Object.freeze({ score: 0.25, edgeDensity: 0.022, straddleDensity: 0.004, meanContrast: 3.2 }),
  minimumCandidates: 20
});

export function classifyHighContrastAdjacency(metric = null, options = {}) {
  const thresholds = options.thresholds || HIGH_CONTRAST_ADJACENCY_THRESHOLDS;
  const candidateSamples = Math.max(0, Math.round(Number(metric?.candidateSamples) || 0));
  if (!metric || candidateSamples < thresholds.minimumCandidates) {
    return { level: 'insufficient', reason: 'insufficient-adjacency-samples', provisional: true };
  }
  const score = Number(metric.score) || 0;
  const edgeDensity = Number(metric.edgeDensity) || 0;
  const straddleDensity = Number(metric.straddleDensity) || 0;
  const meanContrast = Number(metric.meanContrast) || 0;
  const high = thresholds.high;
  const medium = thresholds.medium;
  const isHigh = score >= high.score && edgeDensity >= high.edgeDensity && straddleDensity >= high.straddleDensity && meanContrast >= high.meanContrast;
  const isMedium = score >= medium.score && edgeDensity >= medium.edgeDensity && straddleDensity >= medium.straddleDensity && meanContrast >= medium.meanContrast;
  return {
    level: isHigh ? 'high' : (isMedium ? 'medium' : 'low'),
    reason: isHigh ? 'dense-high-contrast-mask-adjacency' : (isMedium ? 'moderate-high-contrast-mask-adjacency' : 'below-provisional-thresholds'),
    provisional: true
  };
}

export function measureHighContrastAdjacency(image, alphaMap, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, edgeDensity: 0, straddleDensity: 0, meanContrast: 0, p90Contrast: 0, shapeAlignment: 0, sceneEdgeWeight: 0, candidateSamples: 0, edgeSamples: 0, straddleSamples: 0 };
  }
  const { width, height } = image;
  const low = lowPassLuma(image, Math.max(1, Math.min(2, Math.round(options.lowPassRadius ?? 1))));
  const outsideMaxAlpha = Number.isFinite(options.outsideMaxAlpha) ? options.outsideMaxAlpha : 0.018;
  const nearbyMinAlpha = Number.isFinite(options.nearbyMinAlpha) ? options.nearbyMinAlpha : 0.04;
  const adjacencyRadius = Math.max(2, Math.min(8, Math.round(options.adjacencyRadius ?? 5)));
  const minEdge = Number.isFinite(options.minEdge) ? options.minEdge : 2.4;
  const strongEdge = Number.isFinite(options.strongEdge) ? options.strongEdge : 9.0;
  let candidateSamples = 0;
  let edgeSamples = 0;
  let straddleSamples = 0;
  let contrastSum = 0;
  let alignmentSum = 0;
  let sceneWeightSum = 0;
  const contrasts = [];

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha > outsideMaxAlpha) continue;
      if (maxAlphaAround(alphaMap, width, height, x, y, adjacencyRadius) < nearbyMinAlpha) continue;
      candidateSamples++;
      const edge = gradient(low, width, height, x, y);
      if (edge.magnitude < minEdge) continue;
      const strength = smoothstep(minEdge, strongEdge, edge.magnitude);
      if (strength <= 0) continue;
      edgeSamples++;
      contrasts.push(edge.magnitude);
      contrastSum += edge.magnitude;
      const shape = nearestAlphaGradient(alphaMap, width, height, x, y, adjacencyRadius);
      const alignment = cosineAbs(edge, shape);
      alignmentSum += alignment;
      const shapePenalty = 1 - 0.72 * smoothstep(0.58, 0.94, alignment);
      const sceneWeight = strength * shapePenalty;
      sceneWeightSum += sceneWeight;
      if (straddlesMask(alphaMap, width, height, x, y, edge, options)) straddleSamples++;
    }
  }

  contrasts.sort((a, b) => a - b);
  const meanContrast = edgeSamples ? contrastSum / edgeSamples : 0;
  const p90Contrast = contrasts.length ? contrasts[Math.min(contrasts.length - 1, Math.floor(contrasts.length * 0.90))] : 0;
  const edgeDensity = candidateSamples ? edgeSamples / candidateSamples : 0;
  const straddleDensity = candidateSamples ? straddleSamples / candidateSamples : 0;
  const shapeAlignment = edgeSamples ? alignmentSum / edgeSamples : 0;
  const sceneEdgeWeight = candidateSamples ? sceneWeightSum / candidateSamples : 0;
  const densitySignal = smoothstep(0.018, 0.13, edgeDensity);
  const straddleSignal = smoothstep(0.003, 0.045, straddleDensity);
  const contrastSignal = smoothstep(3.0, 12.0, meanContrast);
  const sceneSignal = smoothstep(0.012, 0.10, sceneEdgeWeight);
  const score = clamp(densitySignal * 0.32 + straddleSignal * 0.30 + contrastSignal * 0.20 + sceneSignal * 0.18, 0, 1);

  return {
    score,
    edgeDensity,
    straddleDensity,
    meanContrast,
    p90Contrast,
    shapeAlignment,
    sceneEdgeWeight,
    candidateSamples,
    edgeSamples,
    straddleSamples
  };
}

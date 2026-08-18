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

function lowPassLuma(image, radius = 2) {
  const { width, height } = image;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, weight = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.max(0, Math.min(height - 1, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.max(0, Math.min(width - 1, x + dx));
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

function findOutsideSample(low, alphaMap, width, height, x, y, nx, ny, sign, options) {
  const maxDistance = Math.max(3, Number(options.continuityRadius ?? 8));
  const maxAlpha = Number.isFinite(options.outsideMaxAlpha) ? options.outsideMaxAlpha : 0.012;
  for (let distance = 2; distance <= maxDistance; distance++) {
    const sx = Math.round(x + nx * distance * sign);
    const sy = Math.round(y + ny * distance * sign);
    if (sx < 1 || sy < 1 || sx >= width - 1 || sy >= height - 1) break;
    if ((alphaMap[sy * width + sx] || 0) > maxAlpha) continue;
    return gradient(low, width, height, sx, sy);
  }
  return null;
}

function continuityConfidence(low, alphaMap, width, height, x, y, local, ag, options) {
  if (local.magnitude < 1e-6 || ag.magnitude < 1e-6) return 0;
  const nx = ag.gx / ag.magnitude;
  const ny = ag.gy / ag.magnitude;
  const outsideA = findOutsideSample(low, alphaMap, width, height, x, y, nx, ny, -1, options);
  const outsideB = findOutsideSample(low, alphaMap, width, height, x, y, nx, ny, 1, options);
  let best = 0;
  for (const outside of [outsideA, outsideB]) {
    if (!outside || outside.magnitude < 0.35) continue;
    const orientation = cosineAbs(local, outside);
    const magnitudeRatio = Math.min(local.magnitude, outside.magnitude) / Math.max(local.magnitude, outside.magnitude, 1e-6);
    best = Math.max(best, orientation * smoothstep(0.20, 0.72, magnitudeRatio));
  }
  return clamp(best, 0, 1);
}

export function measureStructuredFootprintResidual(image, alphaMap, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, rawScore: 0, coverage: 0, shapeAlignedDensity: 0, continuityMean: 0, samples: 0, candidateSamples: 0 };
  }
  const { width, height } = image;
  const low = lowPassLuma(image, Math.max(1, Math.min(3, Math.round(options.lowPassRadius ?? 2))));
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.025;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.72;
  const minAlphaGradient = Number.isFinite(options.minAlphaGradient) ? options.minAlphaGradient : 0.002;
  const minImageGradient = Number.isFinite(options.minImageGradient) ? options.minImageGradient : 0.45;
  let weightedRaw = 0, weightedDiscounted = 0, weightSum = 0;
  let continuitySum = 0, samples = 0, alignedSamples = 0, candidateSamples = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      candidateSamples++;
      const ag = alphaGradient(alphaMap, width, height, x, y);
      if (ag.magnitude < minAlphaGradient) continue;
      const ig = gradient(low, width, height, x, y);
      if (ig.magnitude < minImageGradient) continue;
      const alignment = cosineAbs(ag, ig);
      const alphaBand = smoothstep(minAlpha, 0.12, alpha) * (1 - smoothstep(0.58, maxAlpha, alpha));
      const alignmentWeight = smoothstep(0.42, 0.90, alignment);
      const weight = Math.max(0.08, alphaBand) * alignmentWeight;
      if (weight < 0.03) continue;
      const continuity = continuityConfidence(low, alphaMap, width, height, x, y, ig, ag, options);
      const raw = ig.magnitude * alignmentWeight;
      const discounted = raw * (1 - continuity * 0.88);
      weightedRaw += raw * weight;
      weightedDiscounted += discounted * weight;
      weightSum += weight;
      continuitySum += continuity;
      samples++;
      if (alignment >= 0.68 && discounted >= 0.75) alignedSamples++;
    }
  }

  const safePixelCount = Math.max(1, width * height);
  return {
    score: weightSum ? weightedDiscounted / weightSum : 0,
    rawScore: weightSum ? weightedRaw / weightSum : 0,
    coverage: samples / safePixelCount,
    shapeAlignedDensity: alignedSamples / safePixelCount,
    continuityMean: samples ? continuitySum / samples : 0,
    samples,
    candidateSamples
  };
}

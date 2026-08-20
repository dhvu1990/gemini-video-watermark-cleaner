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
function imageGradient(image, x, y) {
  if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const gx = (lumaAt(image, x + 1, y) - lumaAt(image, x - 1, y)) * 0.5;
  const gy = (lumaAt(image, x, y + 1) - lumaAt(image, x, y - 1)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}
function alphaGradient(alphaMap, width, height, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return { gx: 0, gy: 0, magnitude: 0 };
  const p = y * width + x;
  const gx = ((alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0)) * 0.5;
  const gy = ((alphaMap[p + width] || 0) - (alphaMap[p - width] || 0)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}
function cosineAbs(a, b) {
  if (a.magnitude < 1e-6 || b.magnitude < 1e-6) return 0;
  return Math.abs((a.gx * b.gx + a.gy * b.gy) / (a.magnitude * b.magnitude));
}
function gradientSample(image, x, y) {
  const xx = Math.round(x);
  const yy = Math.round(y);
  if (xx < 1 || yy < 1 || xx >= image.width - 1 || yy >= image.height - 1) return null;
  return imageGradient(image, xx, yy);
}
function directionalSimilarity(a, b) {
  if (!b || a.magnitude < 1e-6 || b.magnitude < 1e-6) return 0;
  const orientation = cosineAbs(a, b);
  const strengthRatio = Math.min(a.magnitude, b.magnitude) / Math.max(a.magnitude, b.magnitude);
  return orientation * smoothstep(0.20, 0.70, strengthRatio);
}

export function sceneEdgeProtectionAt(image, alphaMap, x, y, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height) {
    return { weight: 0, gradient: 0, alignment: 0, continuity: 0, alpha: 0 };
  }
  if (x < 2 || y < 2 || x >= image.width - 2 || y >= image.height - 2) {
    return { weight: 0, gradient: 0, alignment: 0, continuity: 0, alpha: 0 };
  }
  const p = y * image.width + x;
  const alpha = alphaMap[p] || 0;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.025;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.90;
  if (alpha < minAlpha || alpha > maxAlpha) return { weight: 0, gradient: 0, alignment: 0, continuity: 0, alpha };

  const edge = imageGradient(image, x, y);
  const minGradient = Number.isFinite(options.minGradient) ? options.minGradient : 3.8;
  const fullGradient = Number.isFinite(options.fullGradient) ? options.fullGradient : 11.0;
  if (edge.magnitude < minGradient) return { weight: 0, gradient: edge.magnitude, alignment: 0, continuity: 0, alpha };

  const shape = alphaGradient(alphaMap, image.width, image.height, x, y);
  const alignment = cosineAbs(edge, shape);
  const alphaGradientFloor = Number.isFinite(options.alphaGradientFloor) ? options.alphaGradientFloor : 0.0012;
  const shapeAligned = shape.magnitude >= alphaGradientFloor ? smoothstep(0.46, 0.82, alignment) : 0;
  const sceneOrientation = 1 - shapeAligned;
  const strength = smoothstep(minGradient, fullGradient, edge.magnitude);

  const tx = edge.magnitude > 1e-6 ? -edge.gy / edge.magnitude : 0;
  const ty = edge.magnitude > 1e-6 ? edge.gx / edge.magnitude : 0;
  const distance = Math.max(2, Math.min(5, Number(options.continuityDistance ?? 3)));
  const positive = gradientSample(image, x + tx * distance, y + ty * distance);
  const negative = gradientSample(image, x - tx * distance, y - ty * distance);
  const continuity = Math.max(directionalSimilarity(edge, positive), directionalSimilarity(edge, negative));
  const continuityBoost = 0.72 + 0.28 * smoothstep(0.35, 0.82, continuity);
  const weight = clamp(strength * sceneOrientation * continuityBoost, 0, 1);

  return { weight, gradient: edge.magnitude, alignment, continuity, alpha };
}

export function measureCrossingSceneEdgeRisk(image, alphaMap, options = {}) {
  if (!image?.data || !alphaMap || alphaMap.length !== image.width * image.height) {
    return {
      score: 0,
      level: 'insufficient',
      protect: false,
      candidateSamples: 0,
      sceneEdgeSamples: 0,
      continuousSamples: 0,
      density: 0,
      continuityDensity: 0,
      meanGradient: 0,
      meanAlignment: 0
    };
  }

  let candidateSamples = 0;
  let sceneEdgeSamples = 0;
  let continuousSamples = 0;
  let gradientSum = 0;
  let alignmentSum = 0;
  let weightSum = 0;
  const sceneThreshold = Number.isFinite(options.sceneThreshold) ? options.sceneThreshold : 0.28;
  const continuousThreshold = Number.isFinite(options.continuousThreshold) ? options.continuousThreshold : 0.42;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.025;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.90;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const alpha = alphaMap[y * image.width + x] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      candidateSamples++;
      const sample = sceneEdgeProtectionAt(image, alphaMap, x, y, options);
      if (sample.weight < sceneThreshold) continue;
      sceneEdgeSamples++;
      weightSum += sample.weight;
      gradientSum += sample.gradient * sample.weight;
      alignmentSum += sample.alignment * sample.weight;
      if (sample.continuity >= continuousThreshold) continuousSamples++;
    }
  }

  const density = candidateSamples ? sceneEdgeSamples / candidateSamples : 0;
  const continuityDensity = candidateSamples ? continuousSamples / candidateSamples : 0;
  const meanGradient = weightSum ? gradientSum / weightSum : 0;
  const meanAlignment = weightSum ? alignmentSum / weightSum : 0;
  const densitySignal = smoothstep(0.014, 0.080, density);
  const continuitySignal = smoothstep(0.005, 0.040, continuityDensity);
  const gradientSignal = smoothstep(4.5, 13.0, meanGradient);
  const score = clamp(densitySignal * 0.46 + continuitySignal * 0.34 + gradientSignal * 0.20, 0, 1);
  const minSamples = Math.max(20, Math.round(Number(options.minSamples ?? 36)));
  const sufficient = candidateSamples >= minSamples;
  const high = sufficient && score >= (options.highScore ?? 0.34) && density >= (options.highDensity ?? 0.028);
  const medium = sufficient && score >= (options.mediumScore ?? 0.19) && density >= (options.mediumDensity ?? 0.014);
  const level = high ? 'high' : (medium ? 'medium' : (sufficient ? 'low' : 'insufficient'));
  const protect = high || (medium && continuityDensity >= (options.protectContinuityDensity ?? 0.010) && meanGradient >= (options.protectMeanGradient ?? 6.0));

  return {
    score,
    level,
    protect,
    candidateSamples,
    sceneEdgeSamples,
    continuousSamples,
    density,
    continuityDensity,
    meanGradient,
    meanAlignment
  };
}

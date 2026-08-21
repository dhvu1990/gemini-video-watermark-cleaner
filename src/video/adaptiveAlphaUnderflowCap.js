function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function lumaAt(image, p) {
  const i = p * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}
function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos), t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function cleanRingLumas(image, alphaMap, x, y, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.014;
  const minRadius = Math.max(4, Math.round(options.minRadius ?? 8));
  const maxRadius = Math.max(minRadius + 2, Math.round(options.maxRadius ?? 28));
  const stride = Math.max(1, Math.round(options.stride ?? 2));
  const values = [];
  const minR2 = minRadius * minRadius;
  const maxR2 = maxRadius * maxRadius;
  for (let dy = -maxRadius; dy <= maxRadius; dy += stride) {
    const yy = y + dy;
    if (yy < 0 || yy >= image.height) continue;
    for (let dx = -maxRadius; dx <= maxRadius; dx += stride) {
      const r2 = dx * dx + dy * dy;
      if (r2 < minR2 || r2 > maxR2) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= image.width) continue;
      const p = yy * image.width + xx;
      if ((alphaMap[p] || 0) > cleanAlpha) continue;
      values.push(lumaAt(image, p));
    }
  }
  return values;
}

function inverseChannel(observed, alpha) {
  return (observed - alpha * 255) / Math.max(1e-4, 1 - alpha);
}

function inverseLuma(image, p, alpha) {
  const i = p * 4;
  return 0.2126 * inverseChannel(image.data[i], alpha)
    + 0.7152 * inverseChannel(image.data[i + 1], alpha)
    + 0.0722 * inverseChannel(image.data[i + 2], alpha);
}

export function buildAdaptiveAlphaUnderflowCap(image, alphaMap, gain = 1, options = {}) {
  const pixels = image?.width * image?.height;
  if (!image?.data || !alphaMap || alphaMap.length !== pixels) {
    return {
      effectiveAlpha: new Float32Array(alphaMap || 0),
      diagnostics: { enabled: false, attempted: false, alphaCappedPixels: 0, rawInverseBlackPixels: 0 }
    };
  }

  const enabled = options.enabled !== false;
  const effectiveAlpha = new Float32Array(pixels);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.16;
  const minCleanSamples = Math.max(10, Math.round(options.minCleanSamples ?? 20));
  const floorPercentile = Number.isFinite(options.floorPercentile) ? options.floorPercentile : 0.35;
  const floorScale = Number.isFinite(options.floorScale) ? options.floorScale : 0.88;
  const minFloor = Number.isFinite(options.minFloor) ? options.minFloor : 6;
  const blackThreshold = Number.isFinite(options.blackThreshold) ? options.blackThreshold : 22;
  const minimumCapDelta = Number.isFinite(options.minimumCapDelta) ? options.minimumCapDelta : 0.015;
  const maxCapFraction = clamp(Number(options.maxCapFraction ?? 0.58), 0.05, 0.75);

  let attemptedPixels = 0;
  let alphaCappedPixels = 0;
  let rawInverseBlackPixels = 0;
  let cappedInverseBlackPixels = 0;
  let rawCoreLumaSum = 0;
  let cappedCoreLumaSum = 0;
  let coreSamples = 0;
  let floorSum = 0;
  let cappedAlphaSum = 0;
  let rawAlphaSum = 0;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = y * image.width + x;
      const rawAlpha = clamp((alphaMap[p] || 0) * gain, 0, 0.99);
      let alpha = rawAlpha;
      effectiveAlpha[p] = alpha;
      if (!enabled || rawAlpha < minAlpha) continue;
      attemptedPixels++;

      const rawY = inverseLuma(image, p, rawAlpha);
      if (rawY <= blackThreshold) rawInverseBlackPixels++;
      const ring = cleanRingLumas(image, alphaMap, x, y, options);
      if (ring.length >= minCleanSamples) {
        const localFloor = Math.max(minFloor, percentile(ring, floorPercentile) * floorScale);
        const observedY = lumaAt(image, p);
        const denominator = Math.max(1e-4, 255 - localFloor);
        const maxAlphaForFloor = clamp((observedY - localFloor) / denominator, 0, 0.99);
        if (maxAlphaForFloor < rawAlpha - minimumCapDelta) {
          const maximumReduction = rawAlpha * maxCapFraction;
          alpha = Math.max(rawAlpha - maximumReduction, maxAlphaForFloor);
          alpha = Math.min(alpha, rawAlpha);
          if (alpha < rawAlpha - minimumCapDelta) {
            alphaCappedPixels++;
            floorSum += localFloor;
            rawAlphaSum += rawAlpha;
            cappedAlphaSum += alpha;
          }
        }
      }
      effectiveAlpha[p] = alpha;
      const cappedY = inverseLuma(image, p, alpha);
      if (cappedY <= blackThreshold) cappedInverseBlackPixels++;
      if ((alphaMap[p] || 0) >= 0.28) {
        rawCoreLumaSum += Math.max(0, rawY);
        cappedCoreLumaSum += Math.max(0, cappedY);
        coreSamples++;
      }
    }
  }

  return {
    effectiveAlpha,
    diagnostics: {
      enabled,
      attempted: enabled && attemptedPixels > 0,
      attemptedPixels,
      alphaCappedPixels,
      rawInverseBlackPixels,
      cappedInverseBlackPixels,
      blackPixelsPrevented: Math.max(0, rawInverseBlackPixels - cappedInverseBlackPixels),
      meanLocalFloor: alphaCappedPixels ? floorSum / alphaCappedPixels : 0,
      meanRawAlpha: alphaCappedPixels ? rawAlphaSum / alphaCappedPixels : 0,
      meanEffectiveAlpha: alphaCappedPixels ? cappedAlphaSum / alphaCappedPixels : 0,
      coreMeanLumaRaw: coreSamples ? rawCoreLumaSum / coreSamples : 0,
      coreMeanLumaCapped: coreSamples ? cappedCoreLumaSum / coreSamples : 0,
      coreSamples
    }
  };
}

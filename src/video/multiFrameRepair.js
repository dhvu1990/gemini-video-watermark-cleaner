function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function luma(data, idx) {
  return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function medianAbsoluteDeviation(values, center = median(values)) {
  if (!values.length || center == null) return 0;
  return median(values.map((value) => Math.abs(value - center))) || 0;
}

function sampleRgb(image, x, y) {
  if (!image || x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const idx = (y * image.width + x) * 4;
  return [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
}

function borderError(current, donor, alphaMap, dx, dy, stride = 2) {
  if (!current || !donor || current.width !== donor.width || current.height !== donor.height) return Number.POSITIVE_INFINITY;
  const { width, height } = current;
  const safeStride = Math.max(1, Math.round(stride));
  let sum = 0;
  let count = 0;
  for (let y = 2; y < height - 2; y += safeStride) {
    for (let x = 2; x < width - 2; x += safeStride) {
      const p = y * width + x;
      if ((alphaMap[p] || 0) > 0.008) continue;
      const sx = x + dx;
      const sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const sp = sy * width + sx;
      if ((alphaMap[sp] || 0) > 0.008) continue;
      const a = luma(current.data, p * 4);
      const b = luma(donor.data, sp * 4);
      sum += Math.abs(a - b);
      count++;
    }
  }
  return count >= Math.max(12, Math.round(24 / safeStride) * 2) ? sum / count : Number.POSITIVE_INFINITY;
}

export function estimateAtlasShift(current, donor, alphaMap, maxShift = 8) {
  const limit = Math.max(1, Math.min(28, Math.round(maxShift || 8)));
  const coarseStep = limit >= 10 ? 2 : 1;
  const coarseStride = limit >= 10 ? 4 : 2;
  const baseline = borderError(current, donor, alphaMap, 0, 0, coarseStride);
  let best = { dx: 0, dy: 0, error: baseline, baseline, improvement: 0 };

  for (let dy = -limit; dy <= limit; dy += coarseStep) {
    for (let dx = -limit; dx <= limit; dx += coarseStep) {
      if (dx === 0 && dy === 0) continue;
      const error = borderError(current, donor, alphaMap, dx, dy, coarseStride);
      if (error < best.error) best = { dx, dy, error, baseline, improvement: 0 };
    }
  }

  if (coarseStep > 1 && Number.isFinite(best.error)) {
    const cx = best.dx;
    const cy = best.dy;
    let refined = {
      dx: cx,
      dy: cy,
      error: borderError(current, donor, alphaMap, cx, cy, 2),
      baseline: borderError(current, donor, alphaMap, 0, 0, 2),
      improvement: 0
    };
    for (let dy = Math.max(-limit, cy - 2); dy <= Math.min(limit, cy + 2); dy++) {
      for (let dx = Math.max(-limit, cx - 2); dx <= Math.min(limit, cx + 2); dx++) {
        const error = borderError(current, donor, alphaMap, dx, dy, 2);
        if (error < refined.error) refined = { ...refined, dx, dy, error };
      }
    }
    best = refined;
  }

  best.improvement = Number.isFinite(best.baseline) && best.baseline > 0 && Number.isFinite(best.error)
    ? clamp((best.baseline - best.error) / best.baseline, -1, 1)
    : 0;
  return best;
}

function localMaxAlpha(alphaMap, width, height, x, y, radius = 2) {
  let max = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      max = Math.max(max, alphaMap[yy * width + xx] || 0);
    }
  }
  return max;
}

function isObservedCleanPixel(alphaMap, width, height, x, y, safetyRadius = 2) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  if ((alphaMap[y * width + x] || 0) > 0.008) return false;
  return localMaxAlpha(alphaMap, width, height, x, y, safetyRadius) <= 0.010;
}

function validDonorPixel(alphaMap, width, height, x, y, allowMaskedDonors) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return allowMaskedDonors || (alphaMap[y * width + x] || 0) <= 0.008;
}

function atlasHybridMask(alphaMap, width, height) {
  const mask = new Float32Array(alphaMap.length);
  let maxGradient = 0;
  const gradient = new Float32Array(alphaMap.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      gradient[p] = Math.hypot(gx, gy);
      maxGradient = Math.max(maxGradient, gradient[p]);
    }
  }
  if (maxGradient > 0) for (let p = 0; p < gradient.length; p++) gradient[p] /= maxGradient;
  for (let p = 0; p < alphaMap.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0.004) continue;
    const edgeRing = clamp((gradient[p] || 0) * 0.86 + smoothstep(0.006, 0.07, a) * (1 - smoothstep(0.20, 0.40, a)) * 0.62, 0, 1);
    const core = smoothstep(0.24, 0.50, a) * (1 - edgeRing * 0.88);
    const feather = clamp(smoothstep(0.06, 0.24, a) * (1 - core) * (0.30 + edgeRing * 0.70), 0, 1);
    mask[p] = clamp(edgeRing * 1.0 + feather * 0.42 + core * 0.02, 0, 1);
  }
  return mask;
}

function shiftQuality(shift) {
  const improvement = smoothstep(0.035, 0.30, Math.max(0, shift?.improvement || 0));
  const error = Number.isFinite(shift?.error) ? shift.error : 99;
  const errorQuality = 1 - smoothstep(10, 42, error);
  const motion = Math.hypot(shift?.dx || 0, shift?.dy || 0);
  const motionQuality = smoothstep(1.5, 10, motion);
  return clamp(improvement * 0.50 + errorQuality * 0.26 + motionQuality * 0.24, 0, 1);
}

function shiftEligible(shift, minImprovement) {
  return Number.isFinite(shift?.error) && Number.isFinite(shift?.baseline) && shift.improvement >= minImprovement;
}

export function buildBackgroundAtlas(current, history, alphaMap, options = {}) {
  const { width, height } = current;
  const maxHistory = Math.max(1, Math.min(12, Math.round(options.maxHistory || 8)));
  const minImprovement = Number.isFinite(options.minImprovement) ? options.minImprovement : 0.08;
  const requestedMaxShift = Math.max(1, Math.min(24, Math.round(options.maxShift || 8)));
  // v1.0.129 keeps the legacy atlas inside its requested motion window so old
  // ring/cleaned-donor behavior remains stable. The observed clean-exposure path
  // may search farther because it has stricter clean-pixel and consensus gates.
  const observedMaxShift = Math.max(
    requestedMaxShift,
    Math.min(20, Math.max(12, Math.round(options.temporalExposureMaxShift || 18)))
  );
  const observedMinImprovement = Number.isFinite(options.observedMinImprovement)
    ? Math.max(0, options.observedMinImprovement)
    : Math.max(minImprovement, 0.06);
  const allowMaskedDonors = options.allowMaskedDonors === true;
  const donorSpreadSoft = Number.isFinite(options.donorSpreadSoft) ? Math.max(0, options.donorSpreadSoft) : 10;
  const donorSpreadHard = Number.isFinite(options.donorSpreadHard) ? Math.max(donorSpreadSoft + 1, options.donorSpreadHard) : 32;
  const observedSpreadSoft = Number.isFinite(options.observedSpreadSoft) ? Math.max(0, options.observedSpreadSoft) : 7;
  const observedSpreadHard = Number.isFinite(options.observedSpreadHard) ? Math.max(observedSpreadSoft + 1, options.observedSpreadHard) : 24;
  const safetyRadius = Math.max(1, Math.min(4, Math.round(options.observedSafetyRadius || 2)));
  const donors = [];

  for (const donor of (history || []).slice(-maxHistory)) {
    if (!donor || donor.width !== width || donor.height !== height) continue;
    const legacyShift = estimateAtlasShift(current, donor, alphaMap, requestedMaxShift);
    const legacyEligible = shiftEligible(legacyShift, minImprovement);
    const observedShift = observedMaxShift > requestedMaxShift
      ? estimateAtlasShift(current, donor, alphaMap, observedMaxShift)
      : legacyShift;
    const observedEligible = shiftEligible(observedShift, observedMinImprovement);
    if (!legacyEligible && !observedEligible) continue;
    donors.push({
      image: donor,
      shift: legacyShift,
      legacyShift,
      observedShift,
      legacyEligible,
      observedEligible,
      quality: shiftQuality(observedShift)
    });
  }

  const data = new Uint8ClampedArray(current.data.length);
  const support = new Uint8Array(width * height);
  const confidence = new Float32Array(width * height);
  const donorSpread = new Float32Array(width * height);
  const observedData = new Uint8ClampedArray(current.data.length);
  const observedSupport = new Uint8Array(width * height);
  const observedConfidence = new Float32Array(width * height);
  const observedDonorSpread = new Float32Array(width * height);
  let observedSupportedPixels = 0;
  let observedCoreSupportedPixels = 0;
  let watermarkPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha > 0.008) watermarkPixels++;
      const channels = [[], [], []];
      const improvements = [];
      const donorLuma = [];
      const observedChannels = [[], [], []];
      const observedLuma = [];
      const observedQualities = [];

      for (const donor of donors) {
        if (donor.legacyEligible) {
          const sx = x + donor.legacyShift.dx;
          const sy = y + donor.legacyShift.dy;
          if (validDonorPixel(alphaMap, width, height, sx, sy, allowMaskedDonors)) {
            const rgb = sampleRgb(donor.image, sx, sy);
            if (rgb) {
              channels[0].push(rgb[0]);
              channels[1].push(rgb[1]);
              channels[2].push(rgb[2]);
              donorLuma.push(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
              improvements.push(donor.legacyShift.improvement);
            }
          }
        }

        if (donor.observedEligible) {
          const ox = x + donor.observedShift.dx;
          const oy = y + donor.observedShift.dy;
          if (!isObservedCleanPixel(alphaMap, width, height, ox, oy, safetyRadius)) continue;
          const observedRgb = sampleRgb(donor.image, ox, oy);
          if (!observedRgb) continue;
          observedChannels[0].push(observedRgb[0]);
          observedChannels[1].push(observedRgb[1]);
          observedChannels[2].push(observedRgb[2]);
          observedLuma.push(0.2126 * observedRgb[0] + 0.7152 * observedRgb[1] + 0.0722 * observedRgb[2]);
          observedQualities.push(donor.quality);
        }
      }

      const count = channels[0].length;
      if (count) {
        support[p] = Math.min(255, count);
        const lumaMedian = median(donorLuma);
        const spread = medianAbsoluteDeviation(donorLuma, lumaMedian);
        donorSpread[p] = spread;
        const consistency = 1 - smoothstep(donorSpreadSoft, donorSpreadHard, spread);
        const maskedPenalty = allowMaskedDonors && alpha > 0.008 ? 0.82 : 1;
        confidence[p] = clamp(((count / 4) * 0.7 + (median(improvements) || 0) * 0.3) * maskedPenalty * consistency, 0, 1);
        const idx = p * 4;
        data[idx] = Math.round(median(channels[0]));
        data[idx + 1] = Math.round(median(channels[1]));
        data[idx + 2] = Math.round(median(channels[2]));
        data[idx + 3] = 255;
      }

      const observedCount = observedChannels[0].length;
      if (observedCount) {
        observedSupport[p] = Math.min(255, observedCount);
        const observedMedian = median(observedLuma);
        const spread = medianAbsoluteDeviation(observedLuma, observedMedian);
        observedDonorSpread[p] = spread;
        const consistency = 1 - smoothstep(observedSpreadSoft, observedSpreadHard, spread);
        const supportQuality = clamp(observedCount / 3, 0, 1);
        const alignmentQuality = median(observedQualities) || 0;
        observedConfidence[p] = clamp((supportQuality * 0.54 + alignmentQuality * 0.46) * consistency, 0, 1);
        const idx = p * 4;
        observedData[idx] = Math.round(median(observedChannels[0]));
        observedData[idx + 1] = Math.round(median(observedChannels[1]));
        observedData[idx + 2] = Math.round(median(observedChannels[2]));
        observedData[idx + 3] = 255;
        if (observedCount >= 2) {
          observedSupportedPixels++;
          if (alpha >= 0.12) observedCoreSupportedPixels++;
        }
      }
    }
  }

  return {
    width,
    height,
    data,
    support,
    confidence,
    donorSpread,
    observedData,
    observedSupport,
    observedConfidence,
    observedDonorSpread,
    observedSupportedPixels,
    observedCoreSupportedPixels,
    watermarkPixels,
    donorCount: donors.length,
    donors,
    allowMaskedDonors,
    donorSpreadSoft,
    donorSpreadHard,
    observedSpreadSoft,
    observedSpreadHard,
    observedSafetyRadius: safetyRadius,
    maxShift: requestedMaxShift,
    observedMaxShift,
    observedMinImprovement,
    temporalObservedAtlas: true
  };
}

export function applyBackgroundAtlas(processed, alphaMap, atlas, strength = 0.92) {
  if (!atlas || atlas.width !== processed.width || atlas.height !== processed.height) return processed;
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  const out = new Uint8ClampedArray(processed.data);
  const legacyMinSupport = atlas.allowMaskedDonors ? 3 : 2;
  const hybrid = atlasHybridMask(alphaMap, processed.width, processed.height);
  const hasObservedAtlas = Boolean(atlas.observedData && atlas.observedSupport && atlas.observedConfidence);
  let correctedPixels = 0;
  let observedCorrectedPixels = 0;
  let observedCoreCorrectedPixels = 0;
  let observedBlendSum = 0;

  for (let p = 0; p < alphaMap.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0.006) continue;

    const observedSupport = hasObservedAtlas ? (atlas.observedSupport[p] || 0) : 0;
    const observedConfidence = hasObservedAtlas ? (atlas.observedConfidence[p] || 0) : 0;
    const observedSpread = hasObservedAtlas ? (atlas.observedDonorSpread?.[p] || 0) : 0;
    const observedEligible = observedSupport >= 2
      && observedConfidence >= 0.26
      && observedSpread <= (atlas.observedSpreadHard ?? 24);

    let support;
    let confidence;
    let regionWeight;
    let targetData;
    let blendCap;
    let observedMode = false;

    if (observedEligible) {
      observedMode = true;
      support = observedSupport;
      confidence = observedConfidence;
      targetData = atlas.observedData;
      const coreWeight = smoothstep(0.025, 0.18, a);
      const bodyWeight = smoothstep(0.008, 0.075, a);
      const temporalWeight = clamp(Math.max(coreWeight * 0.98, bodyWeight * 0.72), 0, 1);
      regionWeight = Math.max(hybrid[p] || 0, temporalWeight);
      blendCap = support >= 3 ? 0.94 : 0.76;
    } else {
      support = atlas.support[p] || 0;
      if (support < legacyMinSupport) continue;
      confidence = atlas.confidence[p] || 0;
      if (confidence < 0.20) continue;
      regionWeight = hybrid[p] || 0;
      if (regionWeight <= 0.01) continue;
      targetData = atlas.data;
      blendCap = 0.92;
    }

    const supportBoost = observedMode ? clamp(support / 3, 0.68, 1) : 1;
    const blend = Math.min(blendCap, safeStrength * confidence * regionWeight * supportBoost);
    if (blend < (observedMode ? 0.032 : 0.04)) continue;
    const idx = p * 4;
    for (let c = 0; c < 3; c++) {
      out[idx + c] = Math.round(processed.data[idx + c] * (1 - blend) + targetData[idx + c] * blend);
    }
    correctedPixels++;
    if (observedMode) {
      observedCorrectedPixels++;
      observedBlendSum += blend;
      if (a >= 0.12) observedCoreCorrectedPixels++;
    }
  }

  return {
    width: processed.width,
    height: processed.height,
    data: out,
    temporalBackgroundAtlas: {
      enabled: true,
      attempted: hasObservedAtlas && (atlas.observedSupportedPixels || 0) > 0,
      correctedPixels,
      observedCorrectedPixels,
      observedCoreCorrectedPixels,
      meanObservedBlend: observedCorrectedPixels ? observedBlendSum / observedCorrectedPixels : 0,
      observedSupportedPixels: atlas.observedSupportedPixels || 0,
      observedCoreSupportedPixels: atlas.observedCoreSupportedPixels || 0,
      donorCount: atlas.donorCount || 0,
      maxShift: atlas.maxShift || null,
      observedMaxShift: atlas.observedMaxShift || atlas.maxShift || null,
      source: 'motion-aligned-clean-exposure'
    }
  };
}

export function summarizeAtlas(atlas) {
  if (!atlas) {
    return {
      donorCount: 0,
      supportedPixels: 0,
      meanConfidence: 0,
      meanDonorSpread: 0,
      observedSupportedPixels: 0,
      observedCoreSupportedPixels: 0,
      meanObservedConfidence: 0
    };
  }
  let supportedPixels = 0;
  let confidenceSum = 0;
  let spreadSum = 0;
  let observedSupportedPixels = 0;
  let observedConfidenceSum = 0;
  let observedSpreadSum = 0;
  const minSupport = atlas.allowMaskedDonors ? 3 : 2;
  for (let i = 0; i < atlas.support.length; i++) {
    if (atlas.support[i] >= minSupport) {
      supportedPixels++;
      confidenceSum += atlas.confidence[i] || 0;
      spreadSum += atlas.donorSpread?.[i] || 0;
    }
    if ((atlas.observedSupport?.[i] || 0) >= 2) {
      observedSupportedPixels++;
      observedConfidenceSum += atlas.observedConfidence?.[i] || 0;
      observedSpreadSum += atlas.observedDonorSpread?.[i] || 0;
    }
  }
  return {
    donorCount: atlas.donorCount || 0,
    supportedPixels,
    meanConfidence: supportedPixels ? confidenceSum / supportedPixels : 0,
    meanDonorSpread: supportedPixels ? spreadSum / supportedPixels : 0,
    donorSpreadSoft: atlas.donorSpreadSoft ?? null,
    donorSpreadHard: atlas.donorSpreadHard ?? null,
    allowMaskedDonors: Boolean(atlas.allowMaskedDonors),
    observedSupportedPixels,
    observedCoreSupportedPixels: atlas.observedCoreSupportedPixels || 0,
    meanObservedConfidence: observedSupportedPixels ? observedConfidenceSum / observedSupportedPixels : 0,
    meanObservedDonorSpread: observedSupportedPixels ? observedSpreadSum / observedSupportedPixels : 0,
    observedCoverage: atlas.watermarkPixels ? (atlas.observedCoreSupportedPixels || 0) / atlas.watermarkPixels : 0,
    observedSafetyRadius: atlas.observedSafetyRadius ?? null,
    maxShift: atlas.maxShift ?? null,
    observedMaxShift: atlas.observedMaxShift ?? atlas.maxShift ?? null,
    observedMinImprovement: atlas.observedMinImprovement ?? null,
    temporalObservedAtlas: Boolean(atlas.temporalObservedAtlas)
  };
}

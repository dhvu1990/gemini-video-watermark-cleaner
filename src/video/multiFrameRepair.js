function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function sampleRgb(image, x, y) {
  if (!image || x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const idx = (y * image.width + x) * 4;
  return [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
}

function borderError(current, donor, alphaMap, dx, dy) {
  if (!current || !donor || current.width !== donor.width || current.height !== donor.height) return Number.POSITIVE_INFINITY;
  const { width, height } = current;
  let sum = 0;
  let count = 0;
  for (let y = 2; y < height - 2; y += 2) {
    for (let x = 2; x < width - 2; x += 2) {
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
  return count >= 24 ? sum / count : Number.POSITIVE_INFINITY;
}

export function estimateAtlasShift(current, donor, alphaMap, maxShift = 8) {
  const baseline = borderError(current, donor, alphaMap, 0, 0);
  let best = { dx: 0, dy: 0, error: baseline, baseline, improvement: 0 };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      if (dx === 0 && dy === 0) continue;
      const error = borderError(current, donor, alphaMap, dx, dy);
      if (error < best.error) best = { dx, dy, error, baseline, improvement: 0 };
    }
  }
  best.improvement = Number.isFinite(baseline) && baseline > 0 && Number.isFinite(best.error)
    ? clamp((baseline - best.error) / baseline, -1, 1)
    : 0;
  return best;
}

function validDonorPixel(alphaMap, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return (alphaMap[y * width + x] || 0) <= 0.008;
}

export function buildBackgroundAtlas(current, history, alphaMap, options = {}) {
  const { width, height } = current;
  const maxHistory = Math.max(1, Math.min(12, Math.round(options.maxHistory || 8)));
  const minImprovement = Number.isFinite(options.minImprovement) ? options.minImprovement : 0.08;
  const maxShift = Math.max(1, Math.min(12, Math.round(options.maxShift || 8)));
  const donors = [];

  for (const donor of (history || []).slice(-maxHistory)) {
    if (!donor || donor.width !== width || donor.height !== height) continue;
    const shift = estimateAtlasShift(current, donor, alphaMap, maxShift);
    if (!Number.isFinite(shift.error) || shift.improvement < minImprovement) continue;
    donors.push({ image: donor, shift });
  }

  const data = new Uint8ClampedArray(current.data.length);
  const support = new Uint8Array(width * height);
  const confidence = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const channels = [[], [], []];
      const improvements = [];
      for (const donor of donors) {
        const sx = x + donor.shift.dx;
        const sy = y + donor.shift.dy;
        if (!validDonorPixel(alphaMap, width, height, sx, sy)) continue;
        const rgb = sampleRgb(donor.image, sx, sy);
        if (!rgb) continue;
        channels[0].push(rgb[0]);
        channels[1].push(rgb[1]);
        channels[2].push(rgb[2]);
        improvements.push(donor.shift.improvement);
      }
      const count = channels[0].length;
      if (!count) continue;
      support[p] = Math.min(255, count);
      confidence[p] = clamp((count / 4) * 0.7 + (median(improvements) || 0) * 0.3, 0, 1);
      const idx = p * 4;
      data[idx] = Math.round(median(channels[0]));
      data[idx + 1] = Math.round(median(channels[1]));
      data[idx + 2] = Math.round(median(channels[2]));
      data[idx + 3] = 255;
    }
  }

  return { width, height, data, support, confidence, donorCount: donors.length, donors };
}

export function applyBackgroundAtlas(processed, alphaMap, atlas, strength = 0.92) {
  if (!atlas || atlas.width !== processed.width || atlas.height !== processed.height) return processed;
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  const out = new Uint8ClampedArray(processed.data);
  for (let p = 0; p < alphaMap.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0.006) continue;
    const support = atlas.support[p] || 0;
    if (support < 2) continue;
    const confidence = atlas.confidence[p] || 0;
    if (confidence < 0.20) continue;
    const alphaGate = clamp((a - 0.006) / 0.34, 0, 1);
    const blend = Math.min(0.94, safeStrength * confidence * (0.55 + alphaGate * 0.45));
    if (blend < 0.12) continue;
    const idx = p * 4;
    for (let c = 0; c < 3; c++) {
      out[idx + c] = Math.round(processed.data[idx + c] * (1 - blend) + atlas.data[idx + c] * blend);
    }
  }
  return { width: processed.width, height: processed.height, data: out };
}

export function summarizeAtlas(atlas) {
  if (!atlas) return { donorCount: 0, supportedPixels: 0, meanConfidence: 0 };
  let supportedPixels = 0;
  let confidenceSum = 0;
  for (let i = 0; i < atlas.support.length; i++) {
    if (atlas.support[i] >= 2) {
      supportedPixels++;
      confidenceSum += atlas.confidence[i] || 0;
    }
  }
  return {
    donorCount: atlas.donorCount || 0,
    supportedPixels,
    meanConfidence: supportedPixels ? confidenceSum / supportedPixels : 0
  };
}

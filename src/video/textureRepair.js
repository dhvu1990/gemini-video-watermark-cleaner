function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function luma(data, index) { return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]; }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function expandedRegion(position, frameWidth, frameHeight, padding = 14) {
  const pad = Math.max(0, Math.round(padding));
  const x = Math.max(0, Math.round(position.x) - pad);
  const y = Math.max(0, Math.round(position.y) - pad);
  const right = Math.min(frameWidth, Math.round(position.x + position.width) + pad);
  const bottom = Math.min(frameHeight, Math.round(position.y + position.height) + pad);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
    offsetX: Math.round(position.x) - x,
    offsetY: Math.round(position.y) - y
  };
}

export function embedAlphaMap(alphaMap, roiWidth, roiHeight, paddedWidth, paddedHeight, offsetX, offsetY) {
  const out = new Float32Array(paddedWidth * paddedHeight);
  for (let y = 0; y < roiHeight; y++) {
    const py = offsetY + y;
    if (py < 0 || py >= paddedHeight) continue;
    for (let x = 0; x < roiWidth; x++) {
      const px = offsetX + x;
      if (px < 0 || px >= paddedWidth) continue;
      out[py * paddedWidth + px] = alphaMap[y * roiWidth + x] || 0;
    }
  }
  return out;
}

export function pasteRegion(base, region, offsetX, offsetY) {
  const out = new Uint8ClampedArray(base.data);
  for (let y = 0; y < region.height; y++) {
    const py = offsetY + y;
    if (py < 0 || py >= base.height) continue;
    for (let x = 0; x < region.width; x++) {
      const px = offsetX + x;
      if (px < 0 || px >= base.width) continue;
      const source = (y * region.width + x) * 4;
      const target = (py * base.width + px) * 4;
      out[target] = region.data[source];
      out[target + 1] = region.data[source + 1];
      out[target + 2] = region.data[source + 2];
      out[target + 3] = region.data[source + 3];
    }
  }
  return { width: base.width, height: base.height, data: out };
}

export function cropRegion(image, offsetX, offsetY, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = offsetX + x;
      const sy = offsetY + y;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const source = (sy * image.width + sx) * 4;
      const target = (y * width + x) * 4;
      data[target] = image.data[source];
      data[target + 1] = image.data[source + 1];
      data[target + 2] = image.data[source + 2];
      data[target + 3] = image.data[source + 3];
    }
  }
  return { width, height, data };
}

function anchorAlong(image, alphaMap, x, y, dx, dy, sign, maxRadius = 22) {
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sx = x + dx * distance * sign;
    const sy = y + dy * distance * sign;
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) break;
    const p = sy * image.width + sx;
    if ((alphaMap[p] || 0) <= 0.008) {
      const i = p * 4;
      return { distance, rgb: [image.data[i], image.data[i + 1], image.data[i + 2]] };
    }
  }
  return null;
}

function pairPrediction(image, alphaMap, x, y, dx, dy) {
  const a = anchorAlong(image, alphaMap, x, y, dx, dy, -1);
  const b = anchorAlong(image, alphaMap, x, y, dx, dy, 1);
  if (!a && !b) return null;
  if (!a || !b) {
    const one = a || b;
    return { rgb: one.rgb, disagreement: 72, support: 0.48, distance: one.distance };
  }
  const total = a.distance + b.distance;
  const rgb = [0, 1, 2].map((c) => (a.rgb[c] * b.distance + b.rgb[c] * a.distance) / total);
  const disagreement = (Math.abs(a.rgb[0] - b.rgb[0]) + Math.abs(a.rgb[1] - b.rgb[1]) + Math.abs(a.rgb[2] - b.rgb[2])) / 3;
  return { rgb, disagreement, support: 1, distance: total * 0.5 };
}

export function applyPaddedTextureRepair(image, alphaMap, strength = 0.72) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || alphaMap.length !== image.width * image.height) return image;
  const out = new Uint8ClampedArray(image.data);
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];

  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < 0.012) continue;
      const candidates = directions
        .map(([dx, dy]) => pairPrediction(image, alphaMap, x, y, dx, dy))
        .filter(Boolean)
        .sort((a, b) => (a.disagreement + a.distance * 0.7) - (b.disagreement + b.distance * 0.7));
      const best = candidates[0];
      if (!best) continue;

      const disagreementGuard = smoothstep(24, 100, best.disagreement);
      const bodyWeight = 0.22 + 0.78 * smoothstep(0.012, 0.36, alpha);
      const blend = Math.min(0.84, safeStrength * bodyWeight * best.support * (1 - disagreementGuard * 0.82));
      if (blend < 0.05) continue;
      const idx = p * 4;
      for (let c = 0; c < 3; c++) out[idx + c] = clampByte(image.data[idx + c] * (1 - blend) + best.rgb[c] * blend);
    }
  }
  return { width: image.width, height: image.height, data: out };
}

function borderSad(current, previous, alphaMap, dx, dy) {
  let sum = 0;
  let count = 0;
  for (let y = 2; y < current.height - 2; y += 2) {
    for (let x = 2; x < current.width - 2; x += 2) {
      const p = y * current.width + x;
      if ((alphaMap[p] || 0) > 0.008) continue;
      const px = x + dx;
      const py = y + dy;
      if (px < 1 || py < 1 || px >= previous.width - 1 || py >= previous.height - 1) continue;
      const a = p * 4;
      const b = (py * previous.width + px) * 4;
      sum += Math.abs(luma(current.data, a) - luma(previous.data, b));
      count++;
    }
  }
  return count ? sum / count : Number.POSITIVE_INFINITY;
}

export function estimateTemporalShift(current, previous, alphaMap, radius = 7) {
  if (!previous || previous.width !== current.width || previous.height !== current.height) return null;
  const zero = borderSad(current, previous, alphaMap, 0, 0);
  let best = { dx: 0, dy: 0, error: zero };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const error = borderSad(current, previous, alphaMap, dx, dy);
      if (error < best.error) best = { dx, dy, error };
    }
  }
  if (!Number.isFinite(best.error) || !Number.isFinite(zero)) return null;
  return { ...best, zeroError: zero, improvement: zero > 0 ? clamp((zero - best.error) / zero, 0, 1) : 0 };
}

export function applyTemporalDonorRepair(processed, currentOriginal, previousOriginal, alphaMap, strength = 0.62) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || !previousOriginal || alphaMap.length !== processed.width * processed.height) return processed;
  const shift = estimateTemporalShift(currentOriginal, previousOriginal, alphaMap, 7);
  if (!shift || (shift.dx === 0 && shift.dy === 0) || shift.improvement < 0.08) return processed;

  const out = new Uint8ClampedArray(processed.data);
  const support = clamp(shift.improvement * 2.4, 0, 1);
  for (let y = 0; y < processed.height; y++) {
    for (let x = 0; x < processed.width; x++) {
      const p = y * processed.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < 0.012) continue;
      const sx = x + shift.dx;
      const sy = y + shift.dy;
      if (sx < 0 || sy < 0 || sx >= previousOriginal.width || sy >= previousOriginal.height) continue;
      const donorP = sy * previousOriginal.width + sx;
      if ((alphaMap[donorP] || 0) > 0.008) continue;
      const idx = p * 4;
      const donor = donorP * 4;
      const blend = Math.min(0.88, safeStrength * support * (0.35 + 0.65 * smoothstep(0.012, 0.34, alpha)));
      for (let c = 0; c < 3; c++) out[idx + c] = clampByte(processed.data[idx + c] * (1 - blend) + previousOriginal.data[donor + c] * blend);
    }
  }
  return { width: processed.width, height: processed.height, data: out, temporalShift: shift };
}

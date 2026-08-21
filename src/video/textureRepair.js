import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from './sceneEdgeProtection.js';

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

function alphaGradient(alphaMap, width, height) {
  const gradient = new Float32Array(alphaMap.length);
  let maxGradient = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const value = Math.hypot(gx, gy);
      gradient[p] = value;
      maxGradient = Math.max(maxGradient, value);
    }
  }
  if (maxGradient > 0) {
    for (let p = 0; p < gradient.length; p++) gradient[p] /= maxGradient;
  }
  return gradient;
}

export function buildHybridRepairMask(alphaMap, width, height) {
  const edge = new Float32Array(alphaMap.length);
  const core = new Float32Array(alphaMap.length);
  const feather = new Float32Array(alphaMap.length);
  const gradient = alphaGradient(alphaMap, width, height);

  for (let p = 0; p < alphaMap.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0.004) continue;
    const lowAlphaRing = smoothstep(0.006, 0.06, a) * (1 - smoothstep(0.18, 0.38, a));
    const gradientRing = gradient[p] || 0;
    edge[p] = clamp(gradientRing * 0.82 + lowAlphaRing * 0.64, 0, 1);
    core[p] = smoothstep(0.24, 0.50, a) * (1 - edge[p] * 0.86);
    feather[p] = clamp(smoothstep(0.06, 0.24, a) * (1 - core[p]) * (0.30 + edge[p] * 0.70), 0, 1);
  }

  return { edge, core, feather };
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

function directionalConsensus(candidates) {
  const strong = candidates
    .filter((candidate) => candidate.support >= 0.95 && candidate.disagreement <= 58)
    .sort((a, b) => (a.disagreement + a.distance * 0.7) - (b.disagreement + b.distance * 0.7));
  const pool = strong.length >= 2 ? strong : candidates
    .filter((candidate) => candidate.support >= 0.45 && candidate.disagreement <= 86)
    .sort((a, b) => (a.disagreement + a.distance * 0.7) - (b.disagreement + b.distance * 0.7));
  if (!pool.length) return null;

  const selected = pool.slice(0, 4);
  if (selected.length === 1) {
    return { rgb: selected[0].rgb, confidence: 0.42 * selected[0].support, spread: 0, directions: 1 };
  }

  const weights = selected.map((candidate) => {
    const quality = 1 / (1 + candidate.disagreement * 0.055 + candidate.distance * 0.038);
    return quality * candidate.support;
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const rgb = [0, 1, 2].map((channel) => selected.reduce(
    (sum, candidate, index) => sum + candidate.rgb[channel] * weights[index],
    0
  ) / weightSum);

  let spread = 0;
  for (const candidate of selected) {
    spread += (Math.abs(candidate.rgb[0] - rgb[0]) + Math.abs(candidate.rgb[1] - rgb[1]) + Math.abs(candidate.rgb[2] - rgb[2])) / 3;
  }
  spread /= selected.length;
  const spreadGuard = smoothstep(10, 62, spread);
  const directionSupport = clamp((selected.length - 1) / 3, 0, 1);
  const confidence = clamp((0.58 + directionSupport * 0.42) * (1 - spreadGuard * 0.78), 0.18, 1);
  return { rgb, confidence, spread, directions: selected.length };
}

export function applyPaddedTextureRepair(image, alphaMap, strength = 0.72) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || alphaMap.length !== image.width * image.height) return image;
  const out = new Uint8ClampedArray(image.data);
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const hybridMask = buildHybridRepairMask(alphaMap, image.width, image.height);
  const crossingRisk = measureCrossingSceneEdgeRisk(image, alphaMap, {
    minAlpha: 0.012,
    maxAlpha: 0.88,
    minSamples: 24,
    highScore: 0.28,
    highDensity: 0.020,
    mediumScore: 0.15,
    mediumDensity: 0.010
  });
  const globalSceneFactor = crossingRisk.protect ? 0.12 : (crossingRisk.level === 'medium' ? 0.52 : 1);

  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < 0.012) continue;
      const candidates = directions
        .map(([dx, dy]) => pairPrediction(image, alphaMap, x, y, dx, dy))
        .filter(Boolean);
      const consensus = directionalConsensus(candidates);
      if (!consensus) continue;

      const sceneEdge = sceneEdgeProtectionAt(image, alphaMap, x, y, { minAlpha: 0.012, maxAlpha: 0.88 });
      if (sceneEdge.weight >= 0.60) continue;
      const edgeWeight = hybridMask.edge[p] || 0;
      const featherWeight = hybridMask.feather[p] || 0;
      const coreWeight = hybridMask.core[p] || 0;
      const regionWeight = clamp(edgeWeight * 0.94 + featherWeight * 0.45 + coreWeight * 0.035, 0, 1);
      const multiDirectionGuard = consensus.directions >= 2 ? 1 : (coreWeight > 0.20 ? 0.28 : 0.55);
      const spreadGuard = 1 - smoothstep(16, 72, consensus.spread) * 0.70;
      const sceneFactor = globalSceneFactor * (1 - sceneEdge.weight * 0.94);
      const blend = Math.min(0.76, safeStrength * regionWeight * consensus.confidence * multiDirectionGuard * spreadGuard * sceneFactor);
      if (blend < 0.035) continue;
      const idx = p * 4;
      for (let c = 0; c < 3; c++) out[idx + c] = clampByte(image.data[idx + c] * (1 - blend) + consensus.rgb[c] * blend);
    }
  }
  return {
    width: image.width,
    height: image.height,
    data: out,
    paddedTextureRepair: { crossingRisk, globalSceneFactor }
  };
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

function localGradient(image, x, y) {
  if (!image || x <= 0 || y <= 0 || x >= image.width - 1 || y >= image.height - 1) return null;
  const left = (y * image.width + x - 1) * 4;
  const right = (y * image.width + x + 1) * 4;
  const up = ((y - 1) * image.width + x) * 4;
  const down = ((y + 1) * image.width + x) * 4;
  const gx = (luma(image.data, right) - luma(image.data, left)) * 0.5;
  const gy = (luma(image.data, down) - luma(image.data, up)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function temporalStructureConfidence(processed, donorImage, x, y, sx, sy, options = {}) {
  if (options.structureGuard === false) return { confidence: 1, mismatch: 0, structured: false };
  const current = localGradient(processed, x, y);
  const donor = localGradient(donorImage, sx, sy);
  if (!current || !donor) return { confidence: 1, mismatch: 0, structured: false };

  const maxMagnitude = Math.max(current.magnitude, donor.magnitude);
  const structure = smoothstep(
    Number.isFinite(options.structureSoft) ? options.structureSoft : 10,
    Number.isFinite(options.structureHard) ? options.structureHard : 38,
    maxMagnitude
  );
  if (structure <= 0.001) return { confidence: 1, mismatch: 0, structured: false };

  const denominator = Math.max(1e-6, current.magnitude * donor.magnitude);
  const alignment = denominator > 1e-5
    ? Math.abs((current.gx * donor.gx + current.gy * donor.gy) / denominator)
    : 0;
  const directionMismatch = 1 - clamp(alignment, 0, 1);
  const magnitudeMismatch = Math.abs(current.magnitude - donor.magnitude) / Math.max(12, maxMagnitude);
  const mismatch = clamp(directionMismatch * 0.70 + magnitudeMismatch * 0.45, 0, 1);
  const mismatchGate = smoothstep(
    Number.isFinite(options.mismatchSoft) ? options.mismatchSoft : 0.28,
    Number.isFinite(options.mismatchHard) ? options.mismatchHard : 0.78,
    mismatch
  );
  const confidence = clamp(1 - mismatchGate * structure * 0.88, 0.12, 1);
  return { confidence, mismatch, structured: structure > 0.12 };
}

export function applyTemporalDonorRepair(processed, currentOriginal, previousOriginal, alphaMap, strength = 0.62, options = {}) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  if (safeStrength <= 0 || !previousOriginal || alphaMap.length !== processed.width * processed.height) return processed;
  const shift = estimateTemporalShift(currentOriginal, previousOriginal, alphaMap, 7);
  if (!shift || (shift.dx === 0 && shift.dy === 0) || shift.improvement < 0.08) return processed;

  const out = new Uint8ClampedArray(processed.data);
  const support = clamp(shift.improvement * 2.4, 0, 1);
  const hybridMask = buildHybridRepairMask(alphaMap, processed.width, processed.height);
  let candidatePixels = 0;
  let correctedPixels = 0;
  let guardedPixels = 0;
  let structureConfidenceSum = 0;
  let structureMismatchSum = 0;
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
      const edgeWeight = hybridMask.edge[p] || 0;
      const featherWeight = hybridMask.feather[p] || 0;
      const coreWeight = hybridMask.core[p] || 0;
      const regionWeight = clamp(edgeWeight * 0.96 + featherWeight * 0.50 + coreWeight * 0.025, 0, 1);
      if (regionWeight <= 0.01) continue;
      candidatePixels++;
      const structureMatch = temporalStructureConfidence(processed, previousOriginal, x, y, sx, sy, options);
      structureConfidenceSum += structureMatch.confidence;
      structureMismatchSum += structureMatch.mismatch;
      if (structureMatch.confidence < 0.72) guardedPixels++;
      const blend = Math.min(0.84, safeStrength * support * regionWeight * structureMatch.confidence);
      if (blend < 0.035) continue;
      for (let c = 0; c < 3; c++) out[idx + c] = clampByte(processed.data[idx + c] * (1 - blend) + previousOriginal.data[donor + c] * blend);
      correctedPixels++;
    }
  }
  return {
    width: processed.width,
    height: processed.height,
    data: out,
    temporalShift: shift,
    temporalDonor: {
      structureGuardEnabled: options.structureGuard !== false,
      candidatePixels,
      correctedPixels,
      guardedPixels,
      meanStructureConfidence: candidatePixels ? structureConfidenceSum / candidatePixels : 1,
      meanStructureMismatch: candidatePixels ? structureMismatchSum / candidatePixels : 0
    }
  };
}

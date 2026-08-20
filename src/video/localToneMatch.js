import { measurePostCleanupResidual } from './edgeBridge.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function lumaAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}
function weightedMedian(samples) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, sample) => sum + Math.max(0, sample.weight || 0), 0);
  if (total <= 1e-9) return median(sorted.map((sample) => sample.value));
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += Math.max(0, sample.weight || 0);
    if (cumulative >= total * 0.5) return sample.value;
  }
  return sorted[sorted.length - 1].value;
}

function footprintGeometry(alphaMap, width, height, minAlpha = 0.035) {
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((alphaMap[y * width + x] || 0) < minAlpha) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return maxX >= minX && maxY >= minY
    ? { valid: true, minX, maxX, minY, maxY }
    : { valid: false, minX: 0, maxX: width - 1, minY: 0, maxY: height - 1 };
}

function solve3(matrix, vector) {
  const a = matrix.map((row, r) => [row[0], row[1], row[2], vector[r]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let j = col; j < 4; j++) a[col][j] /= div;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j < 4; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function fitPlane(samples) {
  if (samples.length < 12) return null;
  let s1 = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  let sz = 0, sxz = 0, syz = 0;
  for (const sample of samples) {
    const { x, y, z } = sample;
    s1 += 1; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    sz += z; sxz += x * z; syz += y * z;
  }
  const solved = solve3(
    [[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]],
    [sz, sxz, syz]
  );
  if (!solved) return null;
  return { a: solved[0], bx: solved[1], by: solved[2] };
}
function planeValue(plane, x, y) { return plane.a + plane.bx * x + plane.by * y; }

function collectReferenceSamples(image, alphaMap, geometry, options = {}) {
  const radius = Math.max(2, Math.round(options.referenceRadius ?? 7));
  const maxAlpha = Number.isFinite(options.referenceMaxAlpha) ? options.referenceMaxAlpha : 0.012;
  const samples = [];
  const x0 = Math.max(1, geometry.minX - radius);
  const x1 = Math.min(image.width - 2, geometry.maxX + radius);
  const y0 = Math.max(1, geometry.minY - radius);
  const y1 = Math.min(image.height - 2, geometry.maxY + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * image.width + x;
      if ((alphaMap[p] || 0) > maxAlpha) continue;
      const outside = x < geometry.minX || x > geometry.maxX || y < geometry.minY || y > geometry.maxY;
      if (!outside) continue;
      const gx = Math.abs(lumaAt(image, x + 1, y) - lumaAt(image, x - 1, y)) * 0.5;
      const gy = Math.abs(lumaAt(image, x, y + 1) - lumaAt(image, x, y - 1)) * 0.5;
      if (Math.hypot(gx, gy) > (options.referenceGradientMax ?? 11)) continue;
      samples.push({ x, y, z: lumaAt(image, x, y) });
    }
  }
  return samples;
}

function robustPlane(samples) {
  const initial = fitPlane(samples);
  if (!initial) return null;
  const residuals = samples.map((sample) => Math.abs(sample.z - planeValue(initial, sample.x, sample.y)));
  const mad = median(residuals);
  const cutoff = Math.max(2.5, mad * 2.8);
  const filtered = samples.filter((sample) => Math.abs(sample.z - planeValue(initial, sample.x, sample.y)) <= cutoff);
  return fitPlane(filtered) || initial;
}

function targetSample(image, alphaMap, plane, x, y, options = {}) {
  const p = y * image.width + x;
  const alpha = alphaMap[p] || 0;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.07;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.68;
  if (alpha < minAlpha || alpha > maxAlpha) return null;
  const gx = Math.abs(lumaAt(image, x + 1, y) - lumaAt(image, x - 1, y)) * 0.5;
  const gy = Math.abs(lumaAt(image, x, y + 1) - lumaAt(image, x, y - 1)) * 0.5;
  const gradient = Math.hypot(gx, gy);
  const gradientMax = Number.isFinite(options.gradientMax) ? options.gradientMax : 14;
  if (gradient > gradientMax) return null;
  const current = lumaAt(image, x, y);
  const predicted = planeValue(plane, x, y);
  const alphaWeight = smoothstep(minAlpha, 0.18, alpha) * (1 - smoothstep(0.52, maxAlpha, alpha));
  const textureWeight = 1 - smoothstep(gradientMax * 0.45, gradientMax, gradient);
  const edgeFloor = Number.isFinite(options.footprintWeightFloor) ? options.footprintWeightFloor : 0.025;
  const weight = alphaWeight * textureWeight;
  if (weight < edgeFloor) return null;
  return { p, idx: p * 4, alpha, gradient, current, predicted, residual: current - predicted, weight };
}

export function measureLocalToneMismatch(image, alphaMap, options = {}) {
  if (!alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, signed: 0, samples: 0, referenceSamples: 0, plane: null, geometry: null, weightSum: 0 };
  }
  const geometry = footprintGeometry(alphaMap, image.width, image.height, options.geometryMinAlpha ?? 0.035);
  if (!geometry.valid) return { score: 0, signed: 0, samples: 0, referenceSamples: 0, plane: null, geometry, weightSum: 0 };
  const references = collectReferenceSamples(image, alphaMap, geometry, options);
  const plane = robustPlane(references);
  if (!plane) return { score: 0, signed: 0, samples: 0, referenceSamples: references.length, plane: null, geometry, weightSum: 0 };
  const residuals = [];
  let weightSum = 0;
  for (let y = Math.max(1, geometry.minY); y <= Math.min(image.height - 2, geometry.maxY); y++) {
    for (let x = Math.max(1, geometry.minX); x <= Math.min(image.width - 2, geometry.maxX); x++) {
      const sample = targetSample(image, alphaMap, plane, x, y, options);
      if (sample) {
        residuals.push({ value: sample.residual, weight: sample.weight });
        weightSum += sample.weight;
      }
    }
  }
  const signed = weightedMedian(residuals);
  return {
    score: Math.abs(signed),
    signed,
    samples: residuals.length,
    referenceSamples: references.length,
    plane,
    geometry,
    weightSum
  };
}

function applyTonePass(image, alphaMap, before, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.72), 0, 0.90);
  const maxShift = Math.max(1, Number(options.maxLumaShift ?? 10));
  const maxLocalShift = Math.max(1, Number(options.maxLocalShift ?? 6));
  const localMix = clamp(Number(options.localMix ?? 0.38), 0, 0.65);
  const globalDesired = clamp(-before.signed * strength, -maxShift, maxShift);
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, shiftSum = 0, localShiftSum = 0;
  const { geometry, plane } = before;
  for (let y = Math.max(1, geometry.minY); y <= Math.min(image.height - 2, geometry.maxY); y++) {
    for (let x = Math.max(1, geometry.minX); x <= Math.min(image.width - 2, geometry.maxX); x++) {
      const sample = targetSample(image, alphaMap, plane, x, y, options);
      if (!sample) continue;
      const residualGate = smoothstep(options.minResidual ?? 0.9, options.fullResidual ?? 6.0, Math.abs(sample.residual));
      const signAgreement = sample.residual * before.signed > 0 ? 1 : 0.22;
      const adaptiveMix = signAgreement >= 1 ? localMix * smoothstep(0.08, 0.55, sample.weight) : 0;
      const localDesired = clamp(-sample.residual * strength, -maxLocalShift, maxLocalShift);
      const desired = globalDesired * (1 - adaptiveMix) + localDesired * adaptiveMix;
      const footprintTaper = smoothstep(0.025, 0.40, sample.weight);
      const blend = clamp(sample.weight * (0.62 + footprintTaper * 0.38) * residualGate * signAgreement, 0, 1);
      const shift = desired * blend;
      if (Math.abs(shift) < 0.18) continue;
      for (let c = 0; c < 3; c++) out[sample.idx + c] = clampByte(image.data[sample.idx + c] + shift);
      correctedPixels++;
      shiftSum += Math.abs(shift);
      localShiftSum += Math.abs(localDesired - globalDesired) * adaptiveMix;
    }
  }
  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    meanAbsShift: correctedPixels ? shiftSum / correctedPixels : 0,
    meanLocalAdaptation: correctedPixels ? localShiftSum / correctedPixels : 0,
    requestedShift: globalDesired,
    localMix,
    maxLocalShift
  };
}

export function applyLocalToneMatch(image, alphaMap, options = {}) {
  if (options.enabled === false || !alphaMap || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      localToneMatch: { enabled: false, attempted: false, accepted: false }
    };
  }
  const before = measureLocalToneMismatch(image, alphaMap, options);
  const outerBefore = measurePostCleanupResidual(image, alphaMap);
  const minSamples = Math.max(8, Number(options.minSamples ?? 18));
  const minReferenceSamples = Math.max(12, Number(options.minReferenceSamples ?? 24));
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1.05;
  if (!before.plane || before.samples < minSamples || before.referenceSamples < minReferenceSamples || before.score < minScore) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      localToneMatch: { enabled: true, attempted: false, accepted: false, before, after: before, outerBefore, outerAfter: outerBefore, correctedPixels: 0, improvement: 0 }
    };
  }
  const pass = applyTonePass(image, alphaMap, before, options);
  const after = measureLocalToneMismatch(pass.image, alphaMap, options);
  const outerAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - after.score) / before.score : 0;
  const accepted = pass.correctedPixels > 0
    && improvement >= (options.minImprovement ?? 0.03)
    && after.score <= before.score * 0.97
    && outerAfter.total <= outerBefore.total * 1.005
    && outerAfter.luma <= outerBefore.luma * 1.008
    && outerAfter.chroma <= outerBefore.chroma * 1.006;
  return {
    width: image.width,
    height: image.height,
    data: accepted ? pass.image.data : new Uint8ClampedArray(image.data),
    localToneMatch: {
      enabled: true,
      attempted: true,
      accepted,
      before,
      after: accepted ? after : before,
      candidateAfter: after,
      outerBefore,
      outerAfter: accepted ? outerAfter : outerBefore,
      candidateOuterAfter: outerAfter,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      correctedPixels: accepted ? pass.correctedPixels : 0,
      candidatePixels: pass.correctedPixels,
      meanAbsShift: accepted ? pass.meanAbsShift : 0,
      meanLocalAdaptation: accepted ? pass.meanLocalAdaptation : 0,
      requestedShift: pass.requestedShift,
      localMix: pass.localMix,
      maxLocalShift: pass.maxLocalShift
    }
  };
}

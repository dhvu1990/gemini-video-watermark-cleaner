import { measurePostCleanupResidual } from './edgeBridge.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function bilinearScalar(values, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
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
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const sample = (xx, yy, c) => image.data[(yy * image.width + xx) * 4 + c];
  return [0, 1, 2].map((c) => (
    sample(x0, y0, c) * (1 - fx) * (1 - fy)
    + sample(x1, y0, c) * fx * (1 - fy)
    + sample(x0, y1, c) * (1 - fx) * fy
    + sample(x1, y1, c) * fx * fy
  ));
}

function nearestSource(alphaMap, width, height, x, y, options = {}) {
  const radius = clamp(Number(options.haloRadius ?? 2), 1, 2.5);
  const sourceMinAlpha = Number.isFinite(options.sourceMinAlpha) ? options.sourceMinAlpha : 0.025;
  const limit = Math.ceil(radius);
  let best = null;
  for (let dy = -limit; dy <= limit; dy++) {
    for (let dx = -limit; dx <= limit; dx++) {
      if (dx === 0 && dy === 0) continue;
      const sx = x + dx, sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const distance = Math.hypot(dx, dy);
      if (distance > radius + 1e-6) continue;
      const alpha = alphaMap[sy * width + sx] || 0;
      if (alpha < sourceMinAlpha) continue;
      if (!best || distance < best.distance - 1e-6 || (Math.abs(distance - best.distance) <= 1e-6 && alpha > best.alpha)) {
        best = { x: sx, y: sy, dx, dy, distance, alpha };
      }
    }
  }
  return best;
}

export function buildOuterHaloMask(alphaMap, width, height, options = {}) {
  const mask = new Float32Array(alphaMap.length);
  if (!alphaMap || alphaMap.length !== width * height) return mask;
  const haloMaxAlpha = Number.isFinite(options.haloMaxAlpha) ? options.haloMaxAlpha : 0.012;
  const radius = clamp(Number(options.haloRadius ?? 2), 1, 2.5);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if ((alphaMap[p] || 0) > haloMaxAlpha) continue;
      const source = nearestSource(alphaMap, width, height, x, y, options);
      if (!source) continue;
      const distanceWeight = 1 - smoothstep(0.85, radius + 0.15, source.distance);
      const alphaWeight = smoothstep(options.sourceMinAlpha ?? 0.025, 0.12, source.alpha);
      mask[p] = clamp((0.40 + alphaWeight * 0.60) * distanceWeight, 0, 1);
    }
  }
  return mask;
}

function referenceForHalo(image, alphaMap, x, y, source, options = {}) {
  const inwardX = source.dx / Math.max(1e-6, source.distance);
  const inwardY = source.dy / Math.max(1e-6, source.distance);
  const outwardX = -inwardX, outwardY = -inwardY;
  const tangentX = -outwardY, tangentY = outwardX;
  const maxAlpha = Number.isFinite(options.referenceMaxAlpha) ? options.referenceMaxAlpha : 0.012;
  const values = [];
  for (const distance of [1.5, 2.5, 3.5]) {
    const sx = x + outwardX * distance;
    const sy = y + outwardY * distance;
    const alpha = bilinearScalar(alphaMap, image.width, image.height, sx, sy);
    if (alpha === null || alpha > maxAlpha) continue;
    const rgb = bilinearRgb(image, sx, sy);
    if (rgb) values.push(luma(rgb));
  }
  const baseDistance = 2.5;
  for (const sign of [-1, 1]) {
    const sx = x + outwardX * baseDistance + tangentX * 1.2 * sign;
    const sy = y + outwardY * baseDistance + tangentY * 1.2 * sign;
    const alpha = bilinearScalar(alphaMap, image.width, image.height, sx, sy);
    if (alpha === null || alpha > maxAlpha) continue;
    const rgb = bilinearRgb(image, sx, sy);
    if (rgb) values.push(luma(rgb));
  }
  if (values.length < 3) return null;
  const target = median(values);
  const disagreement = Math.max(...values) - Math.min(...values);
  const tangentA = bilinearRgb(image, x + tangentX * 1.4, y + tangentY * 1.4);
  const tangentB = bilinearRgb(image, x - tangentX * 1.4, y - tangentY * 1.4);
  const tangentSpan = tangentA && tangentB ? Math.abs(luma(tangentA) - luma(tangentB)) : 0;
  const maxDisagreement = Number.isFinite(options.referenceDisagreementMax) ? options.referenceDisagreementMax : 15;
  const maxTangentSpan = Number.isFinite(options.tangentSpanMax) ? options.tangentSpanMax : 18;
  if (disagreement > maxDisagreement || tangentSpan > maxTangentSpan) return null;
  return { target, disagreement, tangentSpan, samples: values.length };
}

function collectHaloSamples(image, alphaMap, options = {}) {
  const mask = buildOuterHaloMask(alphaMap, image.width, image.height, options);
  const samples = [];
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const haloWeight = mask[p] || 0;
      if (haloWeight < 0.08) continue;
      const source = nearestSource(alphaMap, image.width, image.height, x, y, options);
      if (!source) continue;
      const reference = referenceForHalo(image, alphaMap, x, y, source, options);
      if (!reference) continue;
      const idx = p * 4;
      const current = luma([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
      const residual = current - reference.target;
      const structureGuard = Math.max(
        smoothstep(7, options.referenceDisagreementMax ?? 15, reference.disagreement),
        smoothstep(7, options.tangentSpanMax ?? 18, reference.tangentSpan)
      );
      const weight = haloWeight * (1 - structureGuard * 0.88);
      if (weight < 0.04) continue;
      samples.push({ p, idx, current, residual, weight, reference, source });
    }
  }
  return { mask, samples };
}

export function measureOuterHaloResidual(image, alphaMap, options = {}) {
  if (!alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, signed: 0, samples: 0, weight: 0 };
  }
  const collected = collectHaloSamples(image, alphaMap, options);
  let scoreSum = 0, weightSum = 0;
  const signedResiduals = [];
  for (const sample of collected.samples) {
    scoreSum += Math.abs(sample.residual) * sample.weight;
    weightSum += sample.weight;
    signedResiduals.push(sample.residual);
  }
  return {
    score: weightSum ? scoreSum / weightSum : 0,
    signed: median(signedResiduals),
    samples: collected.samples.length,
    weight: weightSum
  };
}

function applyOuterHaloPass(image, alphaMap, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.66), 0, 0.82);
  const maxLumaShift = clamp(Number(options.maxLumaShift ?? 8), 2, 12);
  const collected = collectHaloSamples(image, alphaMap, options);
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, shiftSum = 0, blendSum = 0;
  for (const sample of collected.samples) {
    const residualMagnitude = Math.abs(sample.residual);
    const residualGate = smoothstep(options.minResidual ?? 0.85, options.fullResidual ?? 5.5, residualMagnitude);
    const blend = Math.min(0.52, strength * sample.weight * residualGate);
    if (blend < 0.035) continue;
    const shift = clamp(-sample.residual, -maxLumaShift, maxLumaShift) * blend;
    if (Math.abs(shift) < 0.16) continue;
    for (let c = 0; c < 3; c++) out[sample.idx + c] = clampByte(image.data[sample.idx + c] + shift);
    correctedPixels++;
    shiftSum += Math.abs(shift);
    blendSum += blend;
  }
  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    meanAbsShift: correctedPixels ? shiftSum / correctedPixels : 0,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0
  };
}

export function applyOuterHaloSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || !alphaMap || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      outerHalo: { enabled: false, attempted: false, accepted: false }
    };
  }
  const before = measureOuterHaloResidual(image, alphaMap, options);
  const outerBefore = measurePostCleanupResidual(image, alphaMap);
  const minSamples = Math.max(6, Number(options.minSamples ?? 12));
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.90;
  if (before.samples < minSamples || before.score < minScore) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      outerHalo: {
        enabled: true,
        attempted: false,
        accepted: false,
        before,
        after: before,
        outerBefore,
        outerAfter: outerBefore,
        correctedPixels: 0,
        improvement: 0
      }
    };
  }

  const pass = applyOuterHaloPass(image, alphaMap, options);
  const after = measureOuterHaloResidual(pass.image, alphaMap, options);
  const outerAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - after.score) / before.score : 0;
  const accepted = pass.correctedPixels > 0
    && improvement >= (options.minImprovement ?? 0.04)
    && after.score <= before.score * 0.96
    && outerAfter.total <= outerBefore.total * 1.006 + 0.02
    && outerAfter.luma <= outerBefore.luma * 1.010 + 0.03
    && outerAfter.chroma <= outerBefore.chroma * 1.006 + 0.02;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? pass.image.data : new Uint8ClampedArray(image.data),
    outerHalo: {
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
      meanBlend: accepted ? pass.meanBlend : 0
    }
  };
}

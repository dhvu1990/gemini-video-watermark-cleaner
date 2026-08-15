import { buildHybridRepairMask } from './textureRepair.js';
import { measurePostCleanupResidual } from './edgeBridge.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function rgbToYcbcr(rgb) {
  const y = luma(rgb);
  return [y, (rgb[2] - y) * 0.5389, (rgb[0] - y) * 0.6350];
}
function ycbcrToRgb(y, cb, cr) {
  const r = y + cr / 0.6350;
  const b = y + cb / 0.5389;
  const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return [clampByte(r), clampByte(g), clampByte(b)];
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
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
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

function alphaGradient(alphaMap, width, x, y) {
  const p = y * width + x;
  const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
  const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function imageGradient(image, x, y) {
  const { width, data } = image;
  const left = luma([data[(y * width + x - 1) * 4], data[(y * width + x - 1) * 4 + 1], data[(y * width + x - 1) * 4 + 2]]);
  const right = luma([data[(y * width + x + 1) * 4], data[(y * width + x + 1) * 4 + 1], data[(y * width + x + 1) * 4 + 2]]);
  const up = luma([data[((y - 1) * width + x) * 4], data[((y - 1) * width + x) * 4 + 1], data[((y - 1) * width + x) * 4 + 2]]);
  const down = luma([data[((y + 1) * width + x) * 4], data[((y + 1) * width + x) * 4 + 1], data[((y + 1) * width + x) * 4 + 2]]);
  const gx = (right - left) * 0.5;
  const gy = (down - up) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function findAnchor(image, alphaMap, x, y, nx, ny, sign, mode, maxRadius = 7.5) {
  for (let distance = 0.75; distance <= maxRadius; distance += 0.75) {
    const sx = x + nx * distance * sign;
    const sy = y + ny * distance * sign;
    const alpha = bilinearScalar(alphaMap, image.width, image.height, sx, sy);
    if (alpha === null) break;
    const valid = mode === 'outer' ? alpha <= 0.008 : alpha >= 0.12;
    if (!valid) continue;
    const rgb = bilinearRgb(image, sx, sy);
    if (rgb) return { rgb, distance, alpha };
  }
  return null;
}

function bridgeTarget(outer, inner) {
  const span = outer.distance + inner.distance;
  if (span <= 0) return null;
  const outerWeight = inner.distance / span;
  const innerWeight = outer.distance / span;
  return [0, 1, 2].map((c) => outer.rgb[c] * outerWeight + inner.rgb[c] * innerWeight);
}

function localAlignment(image, alphaMap, x, y) {
  const ag = alphaGradient(alphaMap, image.width, x, y);
  if (ag.magnitude < 0.0014) return null;
  const ig = imageGradient(image, x, y);
  if (ig.magnitude < 0.8) return { ag, ig, alignment: 0 };
  const alignment = Math.abs((ig.gx * ag.gx + ig.gy * ag.gy) / Math.max(1e-6, ig.magnitude * ag.magnitude));
  return { ag, ig, alignment };
}

export function measureStructuredRingResidual(image, alphaMap) {
  const masks = buildHybridRepairMask(alphaMap, image.width, image.height);
  let scoreSum = 0, weightSum = 0, samples = 0;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ring = clamp(edge * 1.10 + feather * 0.22 - core * 1.02, 0, 1);
      if (alpha < 0.006 || ring < 0.18 || core > 0.48) continue;
      const aligned = localAlignment(image, alphaMap, x, y);
      if (!aligned || aligned.alignment < 0.42) continue;
      const nx = aligned.ag.gx / aligned.ag.magnitude;
      const ny = aligned.ag.gy / aligned.ag.magnitude;
      const outer = findAnchor(image, alphaMap, x, y, nx, ny, -1, 'outer');
      const inner = findAnchor(image, alphaMap, x, y, nx, ny, 1, 'inner');
      if (!outer || !inner) continue;
      const target = bridgeTarget(outer, inner);
      if (!target) continue;
      const idx = p * 4;
      const current = rgbToYcbcr([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
      const wanted = rgbToYcbcr(target);
      const lumaResidual = Math.abs(current[0] - wanted[0]);
      const chromaResidual = (Math.abs(current[1] - wanted[1]) + Math.abs(current[2] - wanted[2])) * 0.5;
      const alignmentWeight = smoothstep(0.42, 0.92, aligned.alignment);
      const weight = ring * alignmentWeight * (0.65 + Math.min(0.35, aligned.ag.magnitude * 5));
      scoreSum += (lumaResidual * 0.78 + chromaResidual * 0.22) * weight;
      weightSum += weight;
      samples++;
    }
  }
  return { score: weightSum ? scoreSum / weightSum : 0, samples };
}

function applyStructuredRingPass(image, alphaMap, strength = 0.50) {
  const safeStrength = clamp(Number(strength) || 0, 0, 0.72);
  const masks = buildHybridRepairMask(alphaMap, image.width, image.height);
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, blendSum = 0, deltaSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ring = clamp(edge * 1.16 + feather * 0.24 - core * 1.12, 0, 1);
      if (alpha < 0.006 || ring < 0.22 || core > 0.44) continue;

      const aligned = localAlignment(image, alphaMap, x, y);
      if (!aligned || aligned.alignment < 0.50) continue;
      const nx = aligned.ag.gx / aligned.ag.magnitude;
      const ny = aligned.ag.gy / aligned.ag.magnitude;
      const tx = -ny, ty = nx;
      const outer = findAnchor(image, alphaMap, x, y, nx, ny, -1, 'outer', 6.5);
      const inner = findAnchor(image, alphaMap, x, y, nx, ny, 1, 'inner', 6.5);
      if (!outer || !inner) continue;
      const target = bridgeTarget(outer, inner);
      if (!target) continue;

      const tangentA = bilinearRgb(image, x + tx * 1.5, y + ty * 1.5);
      const tangentB = bilinearRgb(image, x - tx * 1.5, y - ty * 1.5);
      const tangentDelta = tangentA && tangentB
        ? (Math.abs(luma(tangentA) - luma(tangentB)))
        : 0;
      const anchorDelta = (
        Math.abs(outer.rgb[0] - inner.rgb[0])
        + Math.abs(outer.rgb[1] - inner.rgb[1])
        + Math.abs(outer.rgb[2] - inner.rgb[2])
      ) / 3;
      const structureGuard = Math.max(smoothstep(28, 86, anchorDelta), smoothstep(22, 62, tangentDelta));
      const alignmentWeight = smoothstep(0.50, 0.94, aligned.alignment);
      const idx = p * 4;
      const current = rgbToYcbcr([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
      const wanted = rgbToYcbcr(target);
      const lumaResidual = Math.abs(current[0] - wanted[0]);
      const residualGate = smoothstep(1.0, 8.5, lumaResidual);
      const blend = Math.min(0.44, safeStrength * ring * alignmentWeight * residualGate * (1 - structureGuard * 0.90));
      if (blend < 0.035) continue;

      const yValue = current[0] + clamp(wanted[0] - current[0], -16, 16) * blend;
      const chromaBlend = Math.min(0.18, blend * 0.34);
      const cbValue = current[1] + clamp(wanted[1] - current[1], -12, 12) * chromaBlend;
      const crValue = current[2] + clamp(wanted[2] - current[2], -12, 12) * chromaBlend;
      const rgb = ycbcrToRgb(yValue, cbValue, crValue);
      out[idx] = rgb[0];
      out[idx + 1] = rgb[1];
      out[idx + 2] = rgb[2];
      correctedPixels++;
      blendSum += blend;
      deltaSum += Math.abs(yValue - current[0]);
    }
  }

  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanAbsLumaDelta: correctedPixels ? deltaSum / correctedPixels : 0
  };
}

export function applyStructuredResidualRingSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || alphaMap.length !== image.width * image.height) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), structuredRing: { enabled: false, attempted: false, accepted: false } };
  }
  const before = measurePostCleanupResidual(image, alphaMap);
  const alignedBefore = measureStructuredRingResidual(image, alphaMap);
  const totalThreshold = Number.isFinite(options.totalThreshold) ? options.totalThreshold : 0.80;
  const lumaThreshold = Number.isFinite(options.lumaThreshold) ? options.lumaThreshold : 1.35;
  const shouldAttempt = before.total >= totalThreshold || before.luma >= lumaThreshold || alignedBefore.score >= 1.40;
  if (!shouldAttempt) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      structuredRing: { enabled: true, attempted: false, accepted: false, before, after: before, alignedBefore, alignedAfter: alignedBefore, improvement: 0, correctedPixels: 0 }
    };
  }

  const pass = applyStructuredRingPass(image, alphaMap, options.strength ?? 0.50);
  const after = measurePostCleanupResidual(pass.image, alphaMap);
  const alignedAfter = measureStructuredRingResidual(pass.image, alphaMap);
  const totalImprovement = before.total > 1e-6 ? (before.total - after.total) / before.total : 0;
  const alignedImprovement = alignedBefore.score > 1e-6 ? (alignedBefore.score - alignedAfter.score) / alignedBefore.score : 0;
  const accepted = pass.correctedPixels > 0
    && (totalImprovement >= 0.004 || alignedImprovement >= 0.015)
    && after.total <= before.total * 1.005
    && after.luma <= before.luma * 1.01;
  const selected = accepted ? pass.image : image;
  return {
    width: selected.width,
    height: selected.height,
    data: accepted ? selected.data : new Uint8ClampedArray(image.data),
    structuredRing: {
      enabled: true,
      attempted: true,
      accepted,
      before,
      after: accepted ? after : before,
      candidateAfter: after,
      alignedBefore,
      alignedAfter: accepted ? alignedAfter : alignedBefore,
      candidateAlignedAfter: alignedAfter,
      improvement: accepted ? totalImprovement : 0,
      alignedImprovement: accepted ? alignedImprovement : 0,
      correctedPixels: accepted ? pass.correctedPixels : 0,
      candidatePixels: pass.correctedPixels,
      meanBlend: accepted ? pass.meanBlend : 0,
      meanAbsLumaDelta: accepted ? pass.meanAbsLumaDelta : 0
    }
  };
}

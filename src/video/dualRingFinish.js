import { buildHybridRepairMask } from './textureRepair.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

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
  const { width, height, data } = image;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const sample = (xx, yy, c) => data[(yy * width + xx) * 4 + c];
  return [0, 1, 2].map((c) => (
    sample(x0, y0, c) * (1 - fx) * (1 - fy)
    + sample(x1, y0, c) * fx * (1 - fy)
    + sample(x0, y1, c) * (1 - fx) * fy
    + sample(x1, y1, c) * fx * fy
  ));
}

function gradientAt(alphaMap, width, x, y) {
  const p = y * width + x;
  const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
  const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
  const magnitude = Math.hypot(gx, gy);
  return { gx, gy, magnitude };
}

export function buildDualRingMask(alphaMap, width, height) {
  const hybrid = buildHybridRepairMask(alphaMap, width, height);
  const inner = new Float32Array(alphaMap.length);
  const outer = new Float32Array(alphaMap.length);
  const corner = new Float32Array(alphaMap.length);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const halfW = Math.max(1, width / 2);
  const halfH = Math.max(1, height / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      const edge = hybrid.edge[p] || 0;
      const feather = hybrid.feather[p] || 0;
      const core = hybrid.core[p] || 0;
      if (a <= 0.003 || edge + feather < 0.03) continue;

      const lowAlpha = 1 - smoothstep(0.09, 0.22, a);
      const midAlpha = smoothstep(0.055, 0.18, a) * (1 - smoothstep(0.28, 0.48, a));
      outer[p] = clamp((edge * 0.86 + feather * 0.44) * lowAlpha * (1 - core * 0.90), 0, 1);
      inner[p] = clamp((edge * 0.58 + feather * 0.62) * midAlpha * (1 - core * 0.72), 0, 1);

      const nx = Math.abs(x - cx) / halfW;
      const ny = Math.abs(y - cy) / halfH;
      const axisTip = Math.max((1 - nx) * ny, nx * (1 - ny));
      corner[p] = clamp(axisTip * Math.max(inner[p], outer[p]) * 1.30, 0, 1);
    }
  }
  return { inner, outer, corner, core: hybrid.core };
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

function predictedLuma(image, alphaMap, x, y, nx, ny) {
  const outer = findAnchor(image, alphaMap, x, y, nx, ny, -1, 'outer');
  const inner = findAnchor(image, alphaMap, x, y, nx, ny, 1, 'inner');
  if (!outer || !inner) return null;
  const total = outer.distance + inner.distance;
  if (total <= 0) return null;
  const yOuter = luma(outer.rgb);
  const yInner = luma(inner.rgb);
  const target = (yOuter * inner.distance + yInner * outer.distance) / total;
  const disagreement = Math.abs(yOuter - yInner);
  return { target, disagreement, outer, inner };
}

export function measureDualRingResidual(image, alphaMap) {
  const { width, height, data } = image;
  const masks = buildDualRingMask(alphaMap, width, height);
  let innerSum = 0, innerWeight = 0;
  let outerSum = 0, outerWeight = 0;
  let cornerSum = 0, cornerWeight = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const ringWeight = Math.max(masks.inner[p] || 0, masks.outer[p] || 0);
      if (ringWeight < 0.10 || (masks.core[p] || 0) > 0.58) continue;
      const gradient = gradientAt(alphaMap, width, x, y);
      if (gradient.magnitude < 0.0014) continue;
      const nx = gradient.gx / gradient.magnitude;
      const ny = gradient.gy / gradient.magnitude;
      const prediction = predictedLuma(image, alphaMap, x, y, nx, ny);
      if (!prediction) continue;
      const idx = p * 4;
      const current = luma([data[idx], data[idx + 1], data[idx + 2]]);
      const residual = Math.abs(current - prediction.target);
      const iw = masks.inner[p] || 0;
      const ow = masks.outer[p] || 0;
      const cw = masks.corner[p] || 0;
      innerSum += residual * iw; innerWeight += iw;
      outerSum += residual * ow; outerWeight += ow;
      cornerSum += residual * cw; cornerWeight += cw;
    }
  }

  const inner = innerWeight ? innerSum / innerWeight : 0;
  const outer = outerWeight ? outerSum / outerWeight : 0;
  const corner = cornerWeight ? cornerSum / cornerWeight : 0;
  const totalWeight = innerWeight + outerWeight;
  const total = totalWeight ? (innerSum + outerSum) / totalWeight : 0;
  return { total, inner, outer, corner };
}

export function applyDualRingLumaFinish(image, alphaMap, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.56), 0, 1);
  if (strength <= 0 || alphaMap.length !== image.width * image.height) return image;
  const { width, height, data } = image;
  const before = measureDualRingResidual(image, alphaMap);
  const masks = buildDualRingMask(alphaMap, width, height);
  const out = new Uint8ClampedArray(data);
  let correctedPixels = 0;
  let lumaDeltaSum = 0;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const inner = masks.inner[p] || 0;
      const outer = masks.outer[p] || 0;
      const corner = masks.corner[p] || 0;
      const core = masks.core[p] || 0;
      const ringWeight = clamp(inner * 0.72 + outer * 1.00 + corner * 0.18 - core * 0.88, 0, 1);
      if (ringWeight < 0.14 || core > 0.52) continue;

      const gradient = gradientAt(alphaMap, width, x, y);
      if (gradient.magnitude < 0.0015) continue;
      const nx = gradient.gx / gradient.magnitude;
      const ny = gradient.gy / gradient.magnitude;
      const prediction = predictedLuma(image, alphaMap, x, y, nx, ny);
      if (!prediction) continue;
      const structureGuard = smoothstep(28, 92, prediction.disagreement);
      const idx = p * 4;
      const rgb = [data[idx], data[idx + 1], data[idx + 2]];
      const currentY = luma(rgb);
      const residual = prediction.target - currentY;
      const residualGate = smoothstep(1.2, 8.0, Math.abs(residual));
      const cornerBoost = 1 + corner * 0.16;
      const blend = Math.min(0.46, strength * ringWeight * residualGate * cornerBoost * (1 - structureGuard * 0.86));
      if (blend < 0.035) continue;

      const yDelta = clamp(residual, -18, 18) * blend;
      for (let c = 0; c < 3; c++) out[idx + c] = clampByte(data[idx + c] + yDelta);
      correctedPixels++;
      lumaDeltaSum += Math.abs(yDelta);
    }
  }

  const result = { width, height, data: out };
  const after = measureDualRingResidual(result, alphaMap);
  const improvement = before.total > 1e-6 ? (before.total - after.total) / before.total : 0;
  return {
    ...result,
    dualRingFinish: {
      before,
      after,
      improvement,
      correctedPixels,
      meanAbsLumaDelta: correctedPixels ? lumaDeltaSum / correctedPixels : 0
    }
  };
}

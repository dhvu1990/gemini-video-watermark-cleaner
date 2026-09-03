import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureGeometricOutlineResidual } from './protectedResidualRescue.js';
import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from './sceneEdgeProtection.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function rgbDelta(a, b) {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
}
function rgbAt(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const p = (y * image.width + x) * 4;
  return [image.data[p], image.data[p + 1], image.data[p + 2]];
}
function lumaAt(image, x, y) {
  const rgb = rgbAt(image, x, y);
  return rgb ? luma(rgb) : 0;
}
function localGradient(image, x, y) {
  if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1) return 0;
  const gx = (lumaAt(image, x + 1, y) - lumaAt(image, x - 1, y)) * 0.5;
  const gy = (lumaAt(image, x, y + 1) - lumaAt(image, x, y - 1)) * 0.5;
  return Math.hypot(gx, gy);
}
function localContrastAt(image, x, y) {
  if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1) return Infinity;
  const center = lumaAt(image, x, y);
  let peak = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      peak = Math.max(peak, Math.abs(center - lumaAt(image, x + dx, y + dy)));
    }
  }
  return peak;
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}
function optionalDeltaSafe(after, before, tolerance) {
  if (!Number.isFinite(after) || !Number.isFinite(before)) return true;
  return after <= before + tolerance;
}

function footprintGeometry(alphaMap, width, height, minAlpha = 0.025) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = alphaMap[y * width + x] || 0;
      if (alpha < minAlpha) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const w = Math.max(0.001, alpha);
      sx += x * w;
      sy += y * w;
      sw += w;
    }
  }
  if (maxX < minX || maxY < minY || sw <= 0) {
    return { valid: false, minX: 0, maxX: width - 1, minY: 0, maxY: height - 1, centerX: (width - 1) * 0.5, centerY: (height - 1) * 0.5 };
  }
  const boxX = (minX + maxX) * 0.5;
  const boxY = (minY + maxY) * 0.5;
  return {
    valid: true,
    minX,
    maxX,
    minY,
    maxY,
    centerX: boxX * 0.75 + (sx / sw) * 0.25,
    centerY: boxY * 0.75 + (sy / sw) * 0.25
  };
}

function solve3(matrix, vector) {
  const a = matrix.map((row, r) => [row[0], row[1], row[2], vector[r]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let j = col; j < 4; j += 1) a[col][j] /= div;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j < 4; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function fitPlane(samples, getter) {
  if (samples.length < 12) return null;
  let s1 = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  for (const sample of samples) {
    const z = getter(sample);
    s1 += 1;
    sx += sample.x;
    sy += sample.y;
    sxx += sample.x * sample.x;
    syy += sample.y * sample.y;
    sxy += sample.x * sample.y;
    sz += z;
    sxz += sample.x * z;
    syz += sample.y * z;
  }
  const solved = solve3([[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], [sz, sxz, syz]);
  return solved ? { a: solved[0], bx: solved[1], by: solved[2] } : null;
}
function planeAt(plane, x, y) { return plane.a + plane.bx * x + plane.by * y; }

function collectReferences(image, alphaMap, geometry, options = {}) {
  const radius = Math.max(4, Math.round(Number(options.referenceRadius ?? 9)));
  const maxAlpha = Number.isFinite(options.referenceMaxAlpha) ? options.referenceMaxAlpha : 0.010;
  const gradientMax = Number.isFinite(options.referenceGradientMax) ? options.referenceGradientMax : 20;
  const localContrastMax = Number.isFinite(options.referenceLocalContrastMax) ? options.referenceLocalContrastMax : 24;
  const samples = [];
  const x0 = Math.max(1, geometry.minX - radius);
  const x1 = Math.min(image.width - 2, geometry.maxX + radius);
  const y0 = Math.max(1, geometry.minY - radius);
  const y1 = Math.min(image.height - 2, geometry.maxY + radius);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = y * image.width + x;
      if ((alphaMap[p] || 0) > maxAlpha) continue;
      const outside = x < geometry.minX || x > geometry.maxX || y < geometry.minY || y > geometry.maxY;
      if (!outside) continue;
      const gradient = localGradient(image, x, y);
      if (gradient > gradientMax) continue;
      if (localContrastAt(image, x, y) > localContrastMax) continue;
      const rgb = rgbAt(image, x, y);
      if (!rgb) continue;
      samples.push({ x, y, rgb, yValue: luma(rgb), gradient });
    }
  }
  return samples;
}

function robustRgbPlanes(samples) {
  const firstY = fitPlane(samples, (sample) => sample.yValue);
  if (!firstY) return null;
  const residuals = samples.map((sample) => Math.abs(sample.yValue - planeAt(firstY, sample.x, sample.y)));
  const mad = median(residuals);
  const cutoff = Math.max(3.0, mad * 2.8);
  const filtered = samples.filter((sample) => Math.abs(sample.yValue - planeAt(firstY, sample.x, sample.y)) <= cutoff);
  const use = filtered.length >= 12 ? filtered : samples;
  const r = fitPlane(use, (sample) => sample.rgb[0]);
  const g = fitPlane(use, (sample) => sample.rgb[1]);
  const b = fitPlane(use, (sample) => sample.rgb[2]);
  const yPlane = fitPlane(use, (sample) => sample.yValue);
  if (!r || !g || !b || !yPlane) return null;
  return { r, g, b, y: yPlane, filteredSamples: use.length };
}

function referenceStats(samples, planes) {
  if (!samples.length || !planes) {
    return { samples: 0, meanLuma: 0, stdLuma: Infinity, meanGradient: Infinity, edgeFraction: 1, planeMae: Infinity, brightSmooth: false, stableTone: false };
  }
  const meanLuma = samples.reduce((sum, sample) => sum + sample.yValue, 0) / samples.length;
  const variance = samples.reduce((sum, sample) => sum + (sample.yValue - meanLuma) ** 2, 0) / samples.length;
  const meanGradient = samples.reduce((sum, sample) => sum + sample.gradient, 0) / samples.length;
  const edgeFraction = samples.filter((sample) => sample.gradient >= 9).length / samples.length;
  const planeMae = samples.reduce((sum, sample) => sum + Math.abs(sample.yValue - planeAt(planes.y, sample.x, sample.y)), 0) / samples.length;
  const stdLuma = Math.sqrt(variance);
  const enough = samples.length >= 20;
  const brightSmooth = enough && meanLuma >= 135 && stdLuma <= 46 && meanGradient <= 13 && edgeFraction <= 0.22 && planeMae <= 16;
  const stableTone = enough && stdLuma <= 52 && meanGradient <= 15 && edgeFraction <= 0.26 && planeMae <= 12;
  return { samples: samples.length, meanLuma, stdLuma, meanGradient, edgeFraction, planeMae, brightSmooth, stableTone };
}

function predictedRgb(planes, x, y) {
  return [
    planeAt(planes.r, x, y),
    planeAt(planes.g, x, y),
    planeAt(planes.b, x, y)
  ];
}

function outlineOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.outlineMinAlpha) ? options.outlineMinAlpha : 0.018,
    outlineMaxAlpha: Number.isFinite(options.outlineMaxAlpha) ? options.outlineMaxAlpha : 0.40,
    outlineResidualSoft: Number.isFinite(options.measureResidualSoft) ? options.measureResidualSoft : 0.30,
    outlineResidualHard: Number.isFinite(options.measureResidualHard) ? options.measureResidualHard : 3.4,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.76,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function axisTarget(image, alphaMap, geometry, x, y, axis, options = {}) {
  const minRadius = Math.max(2, Math.round(Number(options.axisMinRadius ?? 3)));
  const maxRadius = Math.max(minRadius, Math.round(Number(options.axisMaxRadius ?? 9)));
  const centerAlpha = alphaMap[y * image.width + x] || 0;
  const maxPairDisagreement = Number.isFinite(options.axisMaxPairDisagreement) ? options.axisMaxPairDisagreement : 20;
  let best = null;
  for (let radius = minRadius; radius <= maxRadius; radius += 1) {
    let aX;
    let aY;
    let bX;
    let bY;
    if (axis === 'vertical') {
      aX = Math.round(geometry.centerX - radius);
      bX = Math.round(geometry.centerX + radius);
      aY = y;
      bY = y;
    } else {
      aX = x;
      bX = x;
      aY = Math.round(geometry.centerY - radius);
      bY = Math.round(geometry.centerY + radius);
    }
    const a = rgbAt(image, aX, aY);
    const b = rgbAt(image, bX, bY);
    if (!a || !b) continue;
    const aAlpha = alphaMap[aY * image.width + aX] || 0;
    const bAlpha = alphaMap[bY * image.width + bX] || 0;
    const pairDisagreement = rgbDelta(a, b);
    if (pairDisagreement > maxPairDisagreement) continue;
    const alphaMismatch = Math.abs(aAlpha - bAlpha) + Math.abs((aAlpha + bAlpha) * 0.5 - centerAlpha) * 0.55;
    if (alphaMismatch > Number(options.axisAlphaMismatchMax ?? 0.34)) continue;
    const score = pairDisagreement + alphaMismatch * 30 + radius * 0.12;
    if (!best || score < best.score) {
      best = {
        score,
        radius,
        pairDisagreement,
        alphaMismatch,
        rgb: [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
      };
    }
  }
  return best;
}

function axisSample(image, alphaMap, geometry, x, y, axis, options = {}) {
  const alpha = alphaMap[y * image.width + x] || 0;
  const minAlpha = Number.isFinite(options.axisMinAlpha) ? options.axisMinAlpha : 0.045;
  const maxAlpha = Number.isFinite(options.axisMaxAlpha) ? options.axisMaxAlpha : 0.62;
  if (alpha < minAlpha || alpha > maxAlpha) return null;
  const halfWidth = Number.isFinite(options.axisHalfWidth) ? options.axisHalfWidth : 2.4;
  const axisDistance = axis === 'vertical' ? Math.abs(x - geometry.centerX) : Math.abs(y - geometry.centerY);
  if (axisDistance > halfWidth) return null;
  const centerWeight = 1 - smoothstep(0, halfWidth, axisDistance);
  if (centerWeight <= 0.02) return null;
  const axisLocalContrastMax = Number.isFinite(options.axisLocalContrastMax) ? options.axisLocalContrastMax : 30;
  if (localContrastAt(image, x, y) > axisLocalContrastMax) return null;
  const target = axisTarget(image, alphaMap, geometry, x, y, axis, options);
  if (!target) return null;
  const current = rgbAt(image, x, y);
  if (!current) return null;
  const residual = luma(target.rgb) - luma(current);
  const residualAbs = Math.abs(residual);
  if (residualAbs > Number(options.axisMaxResidual ?? 14)) return null;
  const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
  const hardSceneGuard = Number.isFinite(options.axisHardSceneGuard) ? options.axisHardSceneGuard : 0.64;
  if (scene.weight >= hardSceneGuard) return null;
  return { current, target, residual, residualAbs, centerWeight, scene, alpha };
}

function measureAxisResidual(image, alphaMap, geometry, axis, options = {}) {
  let sum = 0;
  let weightSum = 0;
  let samples = 0;
  const x0 = Math.max(2, geometry.minX);
  const x1 = Math.min(image.width - 3, geometry.maxX);
  const y0 = Math.max(2, geometry.minY);
  const y1 = Math.min(image.height - 3, geometry.maxY);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const sample = axisSample(image, alphaMap, geometry, x, y, axis, options);
      if (!sample) continue;
      const pairGate = 1 - smoothstep(8, Number(options.axisMaxPairDisagreement ?? 20), sample.target.pairDisagreement);
      const weight = sample.centerWeight * (0.45 + pairGate * 0.55) * (1 - sample.scene.weight * 0.85);
      sum += sample.residualAbs * weight;
      weightSum += weight;
      samples += 1;
    }
  }
  return { score: weightSum ? sum / weightSum : 0, samples, weightSum };
}

function buildAxisCandidate(image, alphaMap, geometry, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const axes = ['vertical', 'horizontal'];
  const strength = clamp(Number(options.axisStrength ?? 0.24), 0.10, 0.34);
  const maxBlend = clamp(Number(options.axisMaxBlend ?? 0.14), 0.06, 0.18);
  const maxLumaDelta = clamp(Number(options.axisMaxLumaDelta ?? 4.0), 1.5, 5.0);
  let correctedPixels = 0;
  let meanBlendSum = 0;
  let maxAppliedLumaDelta = 0;
  let sceneGuardedPixels = 0;

  for (const axis of axes) {
    const x0 = Math.max(2, geometry.minX);
    const x1 = Math.min(image.width - 3, geometry.maxX);
    const y0 = Math.max(2, geometry.minY);
    const y1 = Math.min(image.height - 3, geometry.maxY);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const sample = axisSample(image, alphaMap, geometry, x, y, axis, options);
        if (!sample) {
          const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
          if (scene.weight >= Number(options.axisHardSceneGuard ?? 0.64) || localContrastAt(image, x, y) > Number(options.axisLocalContrastMax ?? 30)) sceneGuardedPixels += 1;
          continue;
        }
        const residualGate = smoothstep(Number(options.axisResidualSoft ?? 0.55), Number(options.axisResidualHard ?? 4.5), sample.residualAbs);
        const pairGate = 1 - smoothstep(7, Number(options.axisMaxPairDisagreement ?? 20), sample.target.pairDisagreement);
        const sceneGate = clamp(1 - sample.scene.weight * 1.15, 0, 1);
        const blend = Math.min(maxBlend, strength * sample.centerWeight * residualGate * pairGate * sceneGate);
        if (blend < 0.025) continue;
        let requested = clamp(sample.residual, -maxLumaDelta, maxLumaDelta) * blend;
        if (Math.abs(requested) < 0.52 && sample.residualAbs >= 1.0 && blend >= 0.035) requested = Math.sign(sample.residual) * 0.52;
        const p = y * image.width + x;
        const idx = p * 4;
        const chromaBlend = Math.min(0.014, blend * 0.08);
        const next = [0, 1, 2].map((channel) => clampByte(
          image.data[idx + channel]
          + requested
          + clamp(sample.target.rgb[channel] - image.data[idx + channel], -4, 4) * chromaBlend
        ));
        const beforeResidual = sample.residualAbs;
        const afterResidual = Math.abs(luma(sample.target.rgb) - luma(next));
        if (afterResidual + 0.01 >= beforeResidual) continue;
        if (next[0] === data[idx] && next[1] === data[idx + 1] && next[2] === data[idx + 2]) continue;
        data[idx] = next[0];
        data[idx + 1] = next[1];
        data[idx + 2] = next[2];
        correctedPixels += 1;
        meanBlendSum += blend;
        maxAppliedLumaDelta = Math.max(maxAppliedLumaDelta, Math.abs(luma(next) - luma(sample.current)));
      }
    }
  }
  return {
    width: image.width,
    height: image.height,
    data,
    correctedPixels,
    meanBlend: correctedPixels ? meanBlendSum / correctedPixels : 0,
    maxAppliedLumaDelta,
    sceneGuardedPixels
  };
}

function measurePlaneMismatch(image, alphaMap, geometry, planes, stats, options = {}) {
  if (!planes) return { score: 0, samples: 0, weightSum: 0 };
  const bright = stats.brightSmooth;
  const minAlpha = Number.isFinite(options.planeMinAlpha) ? options.planeMinAlpha : (bright ? 0.035 : 0.060);
  const maxAlpha = Number.isFinite(options.planeMaxAlpha) ? options.planeMaxAlpha : 0.60;
  const gradientMax = Number.isFinite(options.planeGradientMax) ? options.planeGradientMax : (bright ? 24 : 12);
  const hardSceneGuard = Number.isFinite(options.planeHardSceneGuard) ? options.planeHardSceneGuard : (bright ? 0.82 : 0.28);
  const localContrastMax = Number.isFinite(options.planeLocalContrastMax) ? options.planeLocalContrastMax : (bright ? 28 : 18);
  let sum = 0;
  let weightSum = 0;
  let samples = 0;
  for (let y = Math.max(2, geometry.minY); y <= Math.min(image.height - 3, geometry.maxY); y += 1) {
    for (let x = Math.max(2, geometry.minX); x <= Math.min(image.width - 3, geometry.maxX); x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      const gradient = localGradient(image, x, y);
      if (gradient > gradientMax) continue;
      if (localContrastAt(image, x, y) > localContrastMax) continue;
      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) continue;
      const current = rgbAt(image, x, y);
      const target = predictedRgb(planes, x, y);
      const energy = Math.abs(luma(current) - luma(target)) * 0.78 + rgbDelta(current, target) * 0.22;
      const alphaWeight = smoothstep(minAlpha, 0.16, alpha) * (1 - smoothstep(0.48, maxAlpha, alpha));
      const textureWeight = 1 - smoothstep(gradientMax * 0.55, gradientMax, gradient);
      const weight = alphaWeight * textureWeight * (1 - scene.weight * 0.90);
      if (weight < 0.02) continue;
      sum += energy * weight;
      weightSum += weight;
      samples += 1;
    }
  }
  return { score: weightSum ? sum / weightSum : 0, samples, weightSum };
}

function buildPlaneCandidate(image, alphaMap, geometry, planes, stats, crossingEdge, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const bright = stats.brightSmooth;
  const minAlpha = Number.isFinite(options.planeMinAlpha) ? options.planeMinAlpha : (bright ? 0.035 : 0.060);
  const maxAlpha = Number.isFinite(options.planeMaxAlpha) ? options.planeMaxAlpha : 0.60;
  const gradientMax = Number.isFinite(options.planeGradientMax) ? options.planeGradientMax : (bright ? 24 : 12);
  const hardSceneGuard = Number.isFinite(options.planeHardSceneGuard) ? options.planeHardSceneGuard : (bright ? 0.82 : 0.28);
  const localContrastMax = Number.isFinite(options.planeLocalContrastMax) ? options.planeLocalContrastMax : (bright ? 28 : 18);
  const strength = clamp(Number(options.planeStrength ?? (bright ? 0.30 : 0.16)), 0.08, bright ? 0.38 : 0.22);
  const maxBlend = clamp(Number(options.planeMaxBlend ?? (bright ? 0.18 : 0.085)), 0.04, bright ? 0.22 : 0.11);
  const maxChannelDelta = clamp(Number(options.planeMaxChannelDelta ?? (bright ? 6.0 : 3.0)), 1.5, bright ? 7.0 : 4.0);
  let correctedPixels = 0;
  let blendSum = 0;
  let shiftSum = 0;
  let sceneGuardedPixels = 0;

  if (crossingEdge.protect && !bright) {
    return { width: image.width, height: image.height, data, correctedPixels, meanBlend: 0, meanAbsShift: 0, sceneGuardedPixels, blockedByCrossingEdge: true };
  }

  for (let y = Math.max(2, geometry.minY); y <= Math.min(image.height - 3, geometry.maxY); y += 1) {
    for (let x = Math.max(2, geometry.minX); x <= Math.min(image.width - 3, geometry.maxX); x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      const gradient = localGradient(image, x, y);
      if (gradient > gradientMax) continue;
      if (localContrastAt(image, x, y) > localContrastMax) {
        sceneGuardedPixels += 1;
        continue;
      }
      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        sceneGuardedPixels += 1;
        continue;
      }
      const current = rgbAt(image, x, y);
      const target = predictedRgb(planes, x, y);
      const lumaResidual = luma(target) - luma(current);
      const energy = Math.abs(lumaResidual) * 0.78 + rgbDelta(current, target) * 0.22;
      const residualGate = smoothstep(Number(options.planeResidualSoft ?? 0.65), Number(options.planeResidualHard ?? (bright ? 5.5 : 4.0)), energy);
      const alphaWeight = smoothstep(minAlpha, 0.16, alpha) * (1 - smoothstep(0.48, maxAlpha, alpha));
      const textureWeight = 1 - smoothstep(gradientMax * 0.55, gradientMax, gradient);
      const sceneGate = clamp(1 - scene.weight * (bright ? 0.90 : 1.45), 0, 1);
      const blend = Math.min(maxBlend, strength * alphaWeight * textureWeight * residualGate * sceneGate);
      if (blend < 0.024) continue;
      const idx = p * 4;
      const next = [0, 1, 2].map((channel) => {
        const delta = target[channel] - image.data[idx + channel];
        let step = clamp(delta, -maxChannelDelta, maxChannelDelta) * blend;
        if (Math.abs(step) < 0.52 && Math.abs(delta) >= 1.3 && blend >= 0.035) step = Math.sign(delta) * 0.52;
        return clampByte(image.data[idx + channel] + step);
      });
      const beforeEnergy = energy;
      const afterEnergy = Math.abs(luma(next) - luma(target)) * 0.78 + rgbDelta(next, target) * 0.22;
      if (afterEnergy + 0.01 >= beforeEnergy) continue;
      if (next[0] === data[idx] && next[1] === data[idx + 1] && next[2] === data[idx + 2]) continue;
      data[idx] = next[0];
      data[idx + 1] = next[1];
      data[idx + 2] = next[2];
      correctedPixels += 1;
      blendSum += blend;
      shiftSum += rgbDelta(current, next);
    }
  }
  return {
    width: image.width,
    height: image.height,
    data,
    correctedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanAbsShift: correctedPixels ? shiftSum / correctedPixels : 0,
    sceneGuardedPixels,
    blockedByCrossingEdge: false
  };
}

function globalSafe(after, before) {
  return after.total <= before.total * 1.004 + 0.025
    && after.luma <= before.luma * 1.006 + 0.035
    && after.chroma <= before.chroma * 1.004 + 0.16
    && optionalDeltaSafe(after.darkCandidateMean, before.darkCandidateMean, 0.16)
    && optionalDeltaSafe(after.darkCandidatePeak, before.darkCandidatePeak, 0.60)
    && optionalDeltaSafe(after.clipFraction, before.clipFraction, 0.001);
}

export function applyLateResidualHarmonizer(image, alphaMap, options = {}) {
  const geometry = footprintGeometry(alphaMap, image.width, image.height, options.geometryMinAlpha ?? 0.025);
  if (options.enabled === false || !geometry.valid || !alphaMap || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      lateResidualHarmonizer: { eligible: false, attempted: false, accepted: false, profile: 'none' }
    };
  }

  let selected = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const beforeGlobal = measurePostCleanupResidual(selected, alphaMap);
  const beforeOutline = measureGeometricOutlineResidual(selected, alphaMap, outlineOptions(options));
  const crossingEdge = measureCrossingSceneEdgeRisk(selected, alphaMap, options.sceneEdgeOptions || {});

  const axisBeforeVertical = measureAxisResidual(selected, alphaMap, geometry, 'vertical', options);
  const axisBeforeHorizontal = measureAxisResidual(selected, alphaMap, geometry, 'horizontal', options);
  const axisBeforeScore = Math.max(axisBeforeVertical.score, axisBeforeHorizontal.score);
  const axisMinScore = Number.isFinite(options.axisMinScore) ? options.axisMinScore : 0.72;
  let axisDiagnostics = {
    eligible: axisBeforeVertical.samples + axisBeforeHorizontal.samples >= Number(options.axisMinSamples ?? 6) && axisBeforeScore >= axisMinScore,
    attempted: false,
    accepted: false,
    beforeVertical: axisBeforeVertical,
    beforeHorizontal: axisBeforeHorizontal,
    beforeScore: axisBeforeScore,
    correctedPixels: 0
  };

  if (axisDiagnostics.eligible) {
    const candidate = buildAxisCandidate(selected, alphaMap, geometry, options);
    const candidateImage = { width: image.width, height: image.height, data: candidate.data };
    const afterVertical = measureAxisResidual(candidateImage, alphaMap, geometry, 'vertical', options);
    const afterHorizontal = measureAxisResidual(candidateImage, alphaMap, geometry, 'horizontal', options);
    const afterScore = Math.max(afterVertical.score, afterHorizontal.score);
    const candidateGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
    const candidateOutline = measureGeometricOutlineResidual(candidateImage, alphaMap, outlineOptions(options));
    const improvement = axisBeforeScore > 1e-6 ? (axisBeforeScore - afterScore) / axisBeforeScore : 0;
    const axisGlobalSafe = globalSafe(candidateGlobal, beforeGlobal);
    const axisOutlineSafe = candidateOutline.score <= beforeOutline.score * Number(options.maxOutlineRatio ?? 1.004) + 0.025;
    const accepted = candidate.correctedPixels >= Number(options.axisMinCorrectedPixels ?? 3)
      && improvement >= Number(options.axisMinImprovement ?? 0.018)
      && afterScore <= axisBeforeScore * 0.985
      && candidate.meanBlend <= Number(options.axisAcceptedMaxMeanBlend ?? 0.145)
      && candidate.maxAppliedLumaDelta <= Number(options.axisAcceptedMaxLumaDelta ?? 4.25)
      && axisGlobalSafe
      && axisOutlineSafe;
    axisDiagnostics = {
      ...axisDiagnostics,
      attempted: true,
      accepted,
      afterVertical: accepted ? afterVertical : axisBeforeVertical,
      afterHorizontal: accepted ? afterHorizontal : axisBeforeHorizontal,
      candidateAfterVertical: afterVertical,
      candidateAfterHorizontal: afterHorizontal,
      afterScore: accepted ? afterScore : axisBeforeScore,
      candidateAfterScore: afterScore,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      maxAppliedLumaDelta: candidate.maxAppliedLumaDelta,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      globalSafe: axisGlobalSafe,
      outlineSafe: axisOutlineSafe
    };
    if (accepted) selected = candidateImage;
  }

  const references = collectReferences(selected, alphaMap, geometry, options);
  const planes = robustRgbPlanes(references);
  const stats = referenceStats(references, planes);
  const planeEligible = Boolean(planes) && (stats.brightSmooth || stats.stableTone);
  const planeBefore = planeEligible ? measurePlaneMismatch(selected, alphaMap, geometry, planes, stats, options) : { score: 0, samples: 0, weightSum: 0 };
  let planeDiagnostics = {
    eligible: planeEligible && planeBefore.samples >= Number(options.planeMinSamples ?? 8) && planeBefore.score >= Number(options.planeMinScore ?? 0.70),
    attempted: false,
    accepted: false,
    stats,
    before: planeBefore,
    crossingEdge,
    correctedPixels: 0
  };

  if (planeDiagnostics.eligible) {
    const planeBeforeGlobal = measurePostCleanupResidual(selected, alphaMap);
    const planeBeforeOutline = measureGeometricOutlineResidual(selected, alphaMap, outlineOptions(options));
    const candidate = buildPlaneCandidate(selected, alphaMap, geometry, planes, stats, crossingEdge, options);
    const candidateImage = { width: image.width, height: image.height, data: candidate.data };
    const planeAfter = measurePlaneMismatch(candidateImage, alphaMap, geometry, planes, stats, options);
    const candidateGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
    const candidateOutline = measureGeometricOutlineResidual(candidateImage, alphaMap, outlineOptions(options));
    const improvement = planeBefore.score > 1e-6 ? (planeBefore.score - planeAfter.score) / planeBefore.score : 0;
    const planeGlobalSafe = globalSafe(candidateGlobal, planeBeforeGlobal);
    const planeOutlineSafe = candidateOutline.score <= planeBeforeOutline.score * Number(options.maxOutlineRatio ?? 1.004) + 0.025;
    const minImprovement = Number(options.planeMinImprovement ?? (stats.brightSmooth ? 0.014 : 0.020));
    const accepted = !candidate.blockedByCrossingEdge
      && candidate.correctedPixels >= Number(options.planeMinCorrectedPixels ?? 4)
      && improvement >= minImprovement
      && planeAfter.score <= planeBefore.score * (stats.brightSmooth ? 0.990 : 0.985)
      && candidate.meanAbsShift <= Number(options.planeAcceptedMaxMeanShift ?? (stats.brightSmooth ? 1.85 : 1.20))
      && planeGlobalSafe
      && planeOutlineSafe;
    planeDiagnostics = {
      ...planeDiagnostics,
      attempted: !candidate.blockedByCrossingEdge,
      accepted,
      blockedByCrossingEdge: candidate.blockedByCrossingEdge,
      after: accepted ? planeAfter : planeBefore,
      candidateAfter: planeAfter,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      meanAbsShift: accepted ? candidate.meanAbsShift : 0,
      candidateMeanAbsShift: candidate.meanAbsShift,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      globalSafe: planeGlobalSafe,
      outlineSafe: planeOutlineSafe
    };
    if (accepted) selected = candidateImage;
  }

  const axisAccepted = Boolean(axisDiagnostics.accepted);
  const planeAccepted = Boolean(planeDiagnostics.accepted);
  const accepted = axisAccepted || planeAccepted;
  const profiles = [];
  if (axisAccepted) profiles.push('axis-seam-finish');
  if (planeAccepted) profiles.push(stats.brightSmooth ? 'bright-flat-tone-rematch' : 'guarded-tone-rematch');
  const afterGlobal = measurePostCleanupResidual(selected, alphaMap);
  const afterOutline = measureGeometricOutlineResidual(selected, alphaMap, outlineOptions(options));

  return {
    width: selected.width,
    height: selected.height,
    data: selected.data,
    lateResidualHarmonizer: {
      eligible: axisDiagnostics.eligible || planeDiagnostics.eligible,
      attempted: axisDiagnostics.attempted || planeDiagnostics.attempted,
      accepted,
      profile: profiles.length ? profiles.join('+') : 'none',
      geometry,
      crossingEdge,
      referenceStats: stats,
      beforeGlobal,
      afterGlobal,
      beforeOutline,
      afterOutline,
      correctedPixels: (axisDiagnostics.correctedPixels || 0) + (planeDiagnostics.correctedPixels || 0),
      candidateCorrectedPixels: (axisDiagnostics.candidateCorrectedPixels || 0) + (planeDiagnostics.candidateCorrectedPixels || 0),
      sceneGuardedPixels: (axisDiagnostics.sceneGuardedPixels || 0) + (planeDiagnostics.sceneGuardedPixels || 0),
      axisSeam: axisDiagnostics,
      planeTone: planeDiagnostics
    }
  };
}

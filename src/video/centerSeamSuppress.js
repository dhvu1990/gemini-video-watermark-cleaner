import { measurePostCleanupResidual } from './edgeBridge.js';

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
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function footprintGeometry(alphaMap, width, height, minAlpha = 0.035) {
  let minX = width, maxX = -1, minY = height, maxY = -1;
  let weightedX = 0, weightedY = 0, weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alphaMap[y * width + x] || 0;
      if (a < minAlpha) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const w = Math.max(0.001, a);
      weightedX += x * w; weightedY += y * w; weight += w;
    }
  }
  if (maxX < minX || maxY < minY || weight <= 0) {
    return {
      valid: false,
      centerX: (width - 1) * 0.5,
      centerY: (height - 1) * 0.5,
      minX: 0, maxX: width - 1, minY: 0, maxY: height - 1
    };
  }
  const bboxCenterX = (minX + maxX) * 0.5;
  const bboxCenterY = (minY + maxY) * 0.5;
  return {
    valid: true,
    centerX: bboxCenterX * 0.72 + (weightedX / weight) * 0.28,
    centerY: bboxCenterY * 0.72 + (weightedY / weight) * 0.28,
    minX, maxX, minY, maxY
  };
}

function symmetricTarget(image, alphaMap, x, y, centerX, options = {}) {
  const maxRadius = Math.max(2, Math.round(options.maxRadius ?? 7));
  const minRadius = Math.max(1, Math.round(options.minRadius ?? 2));
  const alphaTolerance = Number.isFinite(options.alphaTolerance) ? options.alphaTolerance : 0.22;
  const p = y * image.width + x;
  const centerAlpha = alphaMap[p] || 0;
  let best = null;

  for (let radius = minRadius; radius <= maxRadius; radius++) {
    const lx = Math.round(centerX - radius);
    const rx = Math.round(centerX + radius);
    if (lx < 0 || rx >= image.width) continue;
    const left = rgbAt(image, lx, y);
    const right = rgbAt(image, rx, y);
    if (!left || !right) continue;
    const la = alphaMap[y * image.width + lx] || 0;
    const ra = alphaMap[y * image.width + rx] || 0;
    if (Math.abs(la - ra) > alphaTolerance) continue;
    if (Math.abs(((la + ra) * 0.5) - centerAlpha) > alphaTolerance * 1.35) continue;

    const disagreement = rgbDelta(left, right);
    const alphaMismatch = Math.abs(la - ra) + Math.abs(((la + ra) * 0.5) - centerAlpha) * 0.55;
    const score = disagreement + radius * 0.45 + alphaMismatch * 35;
    if (!best || score < best.score) {
      best = {
        score,
        radius,
        disagreement,
        alphaMismatch,
        rgb: [
          (left[0] + right[0]) * 0.5,
          (left[1] + right[1]) * 0.5,
          (left[2] + right[2]) * 0.5
        ]
      };
    }
  }
  return best;
}

function seamSample(image, alphaMap, x, y, geometry, options = {}) {
  const p = y * image.width + x;
  const alpha = alphaMap[p] || 0;
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.055;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.70;
  if (alpha < minAlpha || alpha > maxAlpha) return null;
  if (y < geometry.minY + 1 || y > geometry.maxY - 1) return null;

  const halfWidth = Number.isFinite(options.halfWidth) ? options.halfWidth : 3.0;
  const dx = Math.abs(x - geometry.centerX);
  if (dx > halfWidth) return null;
  const centerWeight = 1 - smoothstep(0, halfWidth, dx);
  if (centerWeight <= 0.01) return null;

  const target = symmetricTarget(image, alphaMap, x, y, geometry.centerX, options);
  if (!target) return null;
  const maxAnchorDisagreement = Number.isFinite(options.maxAnchorDisagreement)
    ? options.maxAnchorDisagreement
    : 30;
  if (target.disagreement > maxAnchorDisagreement) return null;

  const current = rgbAt(image, x, y);
  const left1 = rgbAt(image, x - 1, y);
  const right1 = rgbAt(image, x + 1, y);
  if (!current || !left1 || !right1) return null;
  const horizontalGradient = Math.abs(luma(right1) - luma(left1));
  const structureGuard = smoothstep(18, 55, horizontalGradient)
    * (1 - smoothstep(0.55, 0.95, centerWeight));
  const residualLuma = Math.abs(luma(current) - luma(target.rgb));
  const residualChroma = rgbDelta(current, target.rgb) - residualLuma * 0.35;
  const alphaBand = smoothstep(minAlpha, 0.16, alpha) * (1 - smoothstep(0.54, maxAlpha, alpha));
  const weight = centerWeight * (0.34 + alphaBand * 0.66) * (1 - structureGuard * 0.90);
  if (weight < 0.04) return null;

  return {
    p,
    idx: p * 4,
    alpha,
    centerWeight,
    current,
    target,
    residualLuma,
    residualChroma: Math.max(0, residualChroma),
    horizontalGradient,
    structureGuard,
    weight
  };
}

export function measureCenterSeamResidual(image, alphaMap, options = {}) {
  if (!alphaMap || alphaMap.length !== image.width * image.height) {
    return { score: 0, luma: 0, chroma: 0, samples: 0, geometry: null };
  }
  const geometry = footprintGeometry(alphaMap, image.width, image.height, options.geometryMinAlpha ?? 0.035);
  let scoreSum = 0, lumaSum = 0, chromaSum = 0, weightSum = 0, samples = 0;
  for (let y = 1; y < image.height - 1; y++) {
    const x0 = Math.max(1, Math.floor(geometry.centerX - (options.halfWidth ?? 3.0)));
    const x1 = Math.min(image.width - 2, Math.ceil(geometry.centerX + (options.halfWidth ?? 3.0)));
    for (let x = x0; x <= x1; x++) {
      const sample = seamSample(image, alphaMap, x, y, geometry, options);
      if (!sample) continue;
      const score = sample.residualLuma * 0.82 + sample.residualChroma * 0.18;
      scoreSum += score * sample.weight;
      lumaSum += sample.residualLuma * sample.weight;
      chromaSum += sample.residualChroma * sample.weight;
      weightSum += sample.weight;
      samples++;
    }
  }
  return {
    score: weightSum ? scoreSum / weightSum : 0,
    luma: weightSum ? lumaSum / weightSum : 0,
    chroma: weightSum ? chromaSum / weightSum : 0,
    samples,
    geometry
  };
}

function applyCenterSeamPass(image, alphaMap, options = {}) {
  const geometry = footprintGeometry(alphaMap, image.width, image.height, options.geometryMinAlpha ?? 0.035);
  const strength = clamp(Number(options.strength ?? 0.55), 0, 0.78);
  const maxLumaDelta = Math.max(2, Number(options.maxLumaDelta ?? 14));
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, blendSum = 0, lumaDeltaSum = 0;

  for (let y = 1; y < image.height - 1; y++) {
    const x0 = Math.max(1, Math.floor(geometry.centerX - (options.halfWidth ?? 3.0)));
    const x1 = Math.min(image.width - 2, Math.ceil(geometry.centerX + (options.halfWidth ?? 3.0)));
    for (let x = x0; x <= x1; x++) {
      const sample = seamSample(image, alphaMap, x, y, geometry, options);
      if (!sample) continue;
      const residualEnergy = sample.residualLuma + sample.residualChroma * 0.16;
      const residualGate = smoothstep(options.minResidual ?? 0.8, options.fullResidual ?? 7.5, residualEnergy);
      const disagreementGate = 1 - smoothstep(16, options.maxAnchorDisagreement ?? 30, sample.target.disagreement);
      const blend = Math.min(
        0.52,
        strength * sample.weight * residualGate * disagreementGate * (1 - sample.structureGuard * 0.92)
      );
      if (blend < 0.028) continue;

      const currentY = luma(sample.current);
      const targetY = luma(sample.target.rgb);
      const yDelta = clamp(targetY - currentY, -maxLumaDelta, maxLumaDelta) * blend;
      const chromaBlend = Math.min(0.12, blend * 0.22);
      for (let c = 0; c < 3; c++) {
        const lumaAdjusted = image.data[sample.idx + c] + yDelta;
        const chromaCorrection = clamp(sample.target.rgb[c] - image.data[sample.idx + c], -10, 10) * chromaBlend;
        out[sample.idx + c] = clampByte(lumaAdjusted + chromaCorrection);
      }
      correctedPixels++;
      blendSum += blend;
      lumaDeltaSum += Math.abs(yDelta);
    }
  }

  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanAbsLumaDelta: correctedPixels ? lumaDeltaSum / correctedPixels : 0,
    geometry
  };
}

export function applyCenterSeamSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || !alphaMap || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      centerSeam: { enabled: false, attempted: false, accepted: false }
    };
  }

  const before = measureCenterSeamResidual(image, alphaMap, options);
  const outerBefore = measurePostCleanupResidual(image, alphaMap);
  const minSamples = Math.max(4, Number(options.minSamples ?? 8));
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.95;
  if (before.samples < minSamples || before.score < minScore) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      centerSeam: {
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

  const pass = applyCenterSeamPass(image, alphaMap, options);
  const candidateAfter = measureCenterSeamResidual(pass.image, alphaMap, options);
  const outerCandidateAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - candidateAfter.score) / before.score : 0;
  const minImprovement = Number.isFinite(options.minImprovement) ? options.minImprovement : 0.008;
  const accepted = pass.correctedPixels > 0
    && improvement >= minImprovement
    && candidateAfter.score <= before.score * 0.992
    && outerCandidateAfter.total <= outerBefore.total * 1.004
    && outerCandidateAfter.luma <= outerBefore.luma * 1.008
    && outerCandidateAfter.chroma <= outerBefore.chroma * 1.010;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? pass.image.data : new Uint8ClampedArray(image.data),
    centerSeam: {
      enabled: true,
      attempted: true,
      accepted,
      before,
      after: accepted ? candidateAfter : before,
      candidateAfter,
      outerBefore,
      outerAfter: accepted ? outerCandidateAfter : outerBefore,
      outerCandidateAfter,
      improvement: accepted ? improvement : 0,
      candidateImprovement: improvement,
      correctedPixels: accepted ? pass.correctedPixels : 0,
      candidatePixels: pass.correctedPixels,
      meanBlend: accepted ? pass.meanBlend : 0,
      candidateMeanBlend: pass.meanBlend,
      meanAbsLumaDelta: accepted ? pass.meanAbsLumaDelta : 0,
      candidateMeanAbsLumaDelta: pass.meanAbsLumaDelta,
      geometry: pass.geometry
    }
  };
}

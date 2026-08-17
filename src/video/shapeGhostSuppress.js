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

function alphaGradient(alphaMap, width, x, y) {
  const p = y * width + x;
  const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
  const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function imageGradient(image, x, y) {
  const { width, data } = image;
  const sampleY = (xx, yy) => {
    const i = (yy * width + xx) * 4;
    return luma([data[i], data[i + 1], data[i + 2]]);
  };
  const gx = (sampleY(x + 1, y) - sampleY(x - 1, y)) * 0.5;
  const gy = (sampleY(x, y + 1) - sampleY(x, y - 1)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function findCleanAnchor(image, alphaMap, x, y, nx, ny, sign, maxRadius = 26) {
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sx = Math.round(x + nx * distance * sign);
    const sy = Math.round(y + ny * distance * sign);
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) break;
    const p = sy * image.width + sx;
    if ((alphaMap[p] || 0) <= 0.006) {
      const i = p * 4;
      return { distance, rgb: [image.data[i], image.data[i + 1], image.data[i + 2]] };
    }
  }
  return null;
}

function bridgePrediction(a, b) {
  if (!a || !b) return null;
  const span = a.distance + b.distance;
  if (span <= 0) return null;
  const rgb = [0, 1, 2].map((c) => (a.rgb[c] * b.distance + b.rgb[c] * a.distance) / span);
  const disagreement = (Math.abs(a.rgb[0] - b.rgb[0]) + Math.abs(a.rgb[1] - b.rgb[1]) + Math.abs(a.rgb[2] - b.rgb[2])) / 3;
  return { rgb, disagreement, span };
}

function ghostSample(image, alphaMap, x, y, options = {}) {
  const p = y * image.width + x;
  const alpha = alphaMap[p] || 0;
  const minAlpha = options.minAlpha ?? 0.085;
  const maxAlpha = options.maxAlpha ?? 0.68;
  if (alpha < minAlpha || alpha > maxAlpha) return null;

  const ag = alphaGradient(alphaMap, image.width, x, y);
  if (ag.magnitude < (options.minAlphaGradient ?? 0.0012)) return null;
  const nx = ag.gx / ag.magnitude;
  const ny = ag.gy / ag.magnitude;
  const a = findCleanAnchor(image, alphaMap, x, y, nx, ny, -1, options.maxRadius ?? 26);
  const b = findCleanAnchor(image, alphaMap, x, y, nx, ny, 1, options.maxRadius ?? 26);
  const target = bridgePrediction(a, b);
  if (!target) return null;

  const ig = imageGradient(image, x, y);
  const alignment = ig.magnitude > 0.75
    ? Math.abs((ig.gx * ag.gx + ig.gy * ag.gy) / Math.max(1e-6, ig.magnitude * ag.magnitude))
    : 0;
  const idx = p * 4;
  const current = rgbToYcbcr([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
  const wanted = rgbToYcbcr(target.rgb);
  const lumaResidual = Math.abs(current[0] - wanted[0]);
  const chromaResidual = (Math.abs(current[1] - wanted[1]) + Math.abs(current[2] - wanted[2])) * 0.5;
  return { p, idx, alpha, ag, ig, alignment, target, current, wanted, lumaResidual, chromaResidual };
}

export function measureShapeGhostResidual(image, alphaMap, options = {}) {
  if (alphaMap.length !== image.width * image.height) return { score: 0, luma: 0, chroma: 0, samples: 0 };
  let scoreSum = 0, lumaSum = 0, chromaSum = 0, weightSum = 0, samples = 0;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const sample = ghostSample(image, alphaMap, x, y, options);
      if (!sample) continue;
      const alignmentWeight = 0.35 + 0.65 * smoothstep(0.38, 0.90, sample.alignment);
      const alphaBand = smoothstep(0.085, 0.18, sample.alpha) * (1 - smoothstep(0.58, 0.72, sample.alpha));
      const anchorGuard = 1 - smoothstep(34, 92, sample.target.disagreement);
      const weight = alignmentWeight * alphaBand * anchorGuard;
      if (weight < 0.05) continue;
      lumaSum += sample.lumaResidual * weight;
      chromaSum += sample.chromaResidual * weight;
      scoreSum += (sample.lumaResidual * 0.72 + sample.chromaResidual * 0.28) * weight;
      weightSum += weight;
      samples++;
    }
  }
  return {
    score: weightSum ? scoreSum / weightSum : 0,
    luma: weightSum ? lumaSum / weightSum : 0,
    chroma: weightSum ? chromaSum / weightSum : 0,
    samples
  };
}

function applyShapeGhostPass(image, alphaMap, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.52), 0, 0.78);
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, blendSum = 0, lumaDeltaSum = 0, darkBoostedPixels = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const sample = ghostSample(image, alphaMap, x, y, options);
      if (!sample) continue;
      if (sample.target.disagreement > (options.maxAnchorDisagreement ?? 76)) continue;

      const alignmentGate = smoothstep(0.38, 0.88, sample.alignment);
      const residualGate = smoothstep(1.2, 10.5, sample.lumaResidual + sample.chromaResidual * 0.22);
      const anchorGate = 1 - smoothstep(30, 78, sample.target.disagreement);
      const spanGate = 1 - smoothstep(26, 46, sample.target.span);
      const bodyBand = smoothstep(0.085, 0.20, sample.alpha) * (1 - smoothstep(0.54, 0.70, sample.alpha));
      const sceneStructureGuard = smoothstep(18, 58, sample.ig.magnitude) * (1 - alignmentGate * 0.86);
      const darkConfidence = (1 - smoothstep(48, 132, sample.current[0])) * alignmentGate * anchorGate;
      const darkBoost = 1 + darkConfidence * 0.24;
      const blend = Math.min(0.46, strength * darkBoost * bodyBand * residualGate * anchorGate * spanGate * (0.30 + alignmentGate * 0.70) * (1 - sceneStructureGuard * 0.88));
      if (blend < 0.028) continue;

      const yDelta = clamp(sample.wanted[0] - sample.current[0], -18, 18) * blend;
      const chromaBlend = Math.min(0.18, blend * 0.32);
      const cb = sample.current[1] + clamp(sample.wanted[1] - sample.current[1], -15, 15) * chromaBlend;
      const cr = sample.current[2] + clamp(sample.wanted[2] - sample.current[2], -15, 15) * chromaBlend;
      const rgb = ycbcrToRgb(sample.current[0] + yDelta, cb, cr);
      out[sample.idx] = rgb[0]; out[sample.idx + 1] = rgb[1]; out[sample.idx + 2] = rgb[2];
      correctedPixels++;
      if (darkConfidence > 0.20) darkBoostedPixels++;
      blendSum += blend;
      lumaDeltaSum += Math.abs(yDelta);
    }
  }

  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    darkBoostedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanAbsLumaDelta: correctedPixels ? lumaDeltaSum / correctedPixels : 0
  };
}

export function applyShapeGhostSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || alphaMap.length !== image.width * image.height) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), shapeGhost: { enabled: false, attempted: false, accepted: false } };
  }

  const before = measureShapeGhostResidual(image, alphaMap, options);
  const outerBefore = measurePostCleanupResidual(image, alphaMap);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1.35;
  if (before.samples < (options.minSamples ?? 8) || before.score < minScore) {
    return {
      width: image.width, height: image.height, data: new Uint8ClampedArray(image.data),
      shapeGhost: { enabled: true, attempted: false, accepted: false, before, after: before, outerBefore, outerAfter: outerBefore, improvement: 0, correctedPixels: 0 }
    };
  }

  const pass = applyShapeGhostPass(image, alphaMap, options);
  const candidateAfter = measureShapeGhostResidual(pass.image, alphaMap, options);
  const outerCandidateAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - candidateAfter.score) / before.score : 0;
  const accepted = pass.correctedPixels > 0
    && improvement >= (options.minImprovement ?? 0.012)
    && candidateAfter.score <= before.score * 0.988
    && outerCandidateAfter.total <= outerBefore.total * 1.006
    && outerCandidateAfter.luma <= outerBefore.luma * 1.010
    && outerCandidateAfter.chroma <= outerBefore.chroma * 1.012;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? pass.image.data : new Uint8ClampedArray(image.data),
    shapeGhost: {
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
      darkBoostedPixels: accepted ? pass.darkBoostedPixels : 0,
      candidateDarkBoostedPixels: pass.darkBoostedPixels,
      meanBlend: accepted ? pass.meanBlend : 0,
      meanAbsLumaDelta: accepted ? pass.meanAbsLumaDelta : 0
    }
  };
}

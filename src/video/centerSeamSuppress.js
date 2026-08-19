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

function weightedAlphaCentroidX(alphaMap, width, height) {
  let sum = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = alphaMap[y * width + x] || 0;
      if (alpha <= 0.01) continue;
      const sampleWeight = Math.min(0.72, alpha);
      sum += x * sampleWeight;
      weight += sampleWeight;
    }
  }
  return weight ? sum / weight : (width - 1) * 0.5;
}

function sampleRgb(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2]];
}

function findCleanHorizontalAnchor(image, alphaMap, x, y, sign, maxRadius) {
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sampleX = x + distance * sign;
    if (sampleX < 0 || sampleX >= image.width) break;
    if ((alphaMap[y * image.width + sampleX] || 0) > 0.006) continue;
    const rgb = sampleRgb(image, sampleX, y);
    if (rgb) return { x: sampleX, y, distance, rgb };
  }
  return null;
}

function bridgePrediction(left, right) {
  if (!left || !right) return null;
  const span = left.distance + right.distance;
  if (span <= 0) return null;
  const leftWeight = right.distance / span;
  const rightWeight = left.distance / span;
  const rgb = [0, 1, 2].map((channel) => left.rgb[channel] * leftWeight + right.rgb[channel] * rightWeight);
  const disagreement = (
    Math.abs(left.rgb[0] - right.rgb[0])
    + Math.abs(left.rgb[1] - right.rgb[1])
    + Math.abs(left.rgb[2] - right.rgb[2])
  ) / 3;
  return { rgb, disagreement, span };
}

function findCleanVerticalAnchor(image, alphaMap, x, y, sign, maxRadius) {
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sampleY = y + distance * sign;
    if (sampleY < 1 || sampleY >= image.height - 1) break;
    if ((alphaMap[sampleY * image.width + x] || 0) > 0.006) continue;
    return { x, y: sampleY, distance };
  }
  return null;
}

function verticalLineContrast(image, x, y, offset = 2) {
  const center = sampleRgb(image, x, y);
  const left = sampleRgb(image, x - offset, y);
  const right = sampleRgb(image, x + offset, y);
  if (!center || !left || !right) return 0;
  return luma(center) - (luma(left) + luma(right)) * 0.5;
}

function persistentVerticalSceneGuard(image, alphaMap, x, y, maxRadius) {
  const up = findCleanVerticalAnchor(image, alphaMap, x, y, -1, maxRadius);
  const down = findCleanVerticalAnchor(image, alphaMap, x, y, 1, maxRadius);
  if (!up || !down) return 0;
  const upContrast = verticalLineContrast(image, up.x, up.y);
  const downContrast = verticalLineContrast(image, down.x, down.y);
  if (upContrast === 0 || downContrast === 0 || Math.sign(upContrast) !== Math.sign(downContrast)) return 0;
  const persistentMagnitude = Math.min(Math.abs(upContrast), Math.abs(downContrast));
  const balance = 1 - smoothstep(7, 24, Math.abs(Math.abs(upContrast) - Math.abs(downContrast)));
  return smoothstep(1.8, 8.5, persistentMagnitude) * balance;
}

function seamSample(image, alphaMap, centroidX, x, y, options = {}) {
  const pixel = y * image.width + x;
  const alpha = alphaMap[pixel] || 0;
  const minAlpha = options.minAlpha ?? 0.055;
  const maxAlpha = options.maxAlpha ?? 0.72;
  if (alpha < minAlpha || alpha > maxAlpha) return null;

  const halfWidth = Math.max(1.25, Number(options.halfWidth ?? 3.0));
  const axisDistance = Math.abs(x - centroidX);
  if (axisDistance > halfWidth) return null;
  const axisWeight = 1 - smoothstep(halfWidth * 0.30, halfWidth, axisDistance);
  if (axisWeight <= 0.02) return null;

  const maxRadius = Math.max(8, Math.min(36, Math.round(options.maxRadius ?? 30)));
  const left = findCleanHorizontalAnchor(image, alphaMap, x, y, -1, maxRadius);
  const right = findCleanHorizontalAnchor(image, alphaMap, x, y, 1, maxRadius);
  const target = bridgePrediction(left, right);
  if (!target) return null;

  const anchorGuard = 1 - smoothstep(options.anchorSoft ?? 14, options.anchorHard ?? 48, target.disagreement);
  if (anchorGuard <= 0.03) return null;

  const sceneGuard = persistentVerticalSceneGuard(image, alphaMap, x, y, options.sceneGuardRadius ?? maxRadius);
  const index = pixel * 4;
  const current = rgbToYcbcr([image.data[index], image.data[index + 1], image.data[index + 2]]);
  const wanted = rgbToYcbcr(target.rgb);
  const lumaResidual = Math.abs(current[0] - wanted[0]);
  const chromaResidual = (Math.abs(current[1] - wanted[1]) + Math.abs(current[2] - wanted[2])) * 0.5;
  const alphaBand = smoothstep(minAlpha, 0.16, alpha) * (1 - smoothstep(0.58, maxAlpha, alpha));

  return {
    pixel,
    index,
    alpha,
    axisDistance,
    axisWeight,
    alphaBand,
    target,
    anchorGuard,
    sceneGuard,
    current,
    wanted,
    lumaResidual,
    chromaResidual
  };
}

export function measureCenterSeamResidual(image, alphaMap, options = {}) {
  if (alphaMap.length !== image.width * image.height) {
    return { score: 0, luma: 0, chroma: 0, samples: 0, centroidX: (image.width - 1) * 0.5 };
  }
  const centroidX = Number.isFinite(options.centroidX)
    ? options.centroidX
    : weightedAlphaCentroidX(alphaMap, image.width, image.height);
  let scoreSum = 0;
  let lumaSum = 0;
  let chromaSum = 0;
  let weightSum = 0;
  let samples = 0;
  let guardedSamples = 0;

  for (let y = 2; y < image.height - 2; y++) {
    const minX = Math.max(2, Math.floor(centroidX - (options.halfWidth ?? 3.0) - 1));
    const maxX = Math.min(image.width - 3, Math.ceil(centroidX + (options.halfWidth ?? 3.0) + 1));
    for (let x = minX; x <= maxX; x++) {
      const sample = seamSample(image, alphaMap, centroidX, x, y, options);
      if (!sample) continue;
      const sceneWeight = 1 - sample.sceneGuard * 0.96;
      const weight = sample.axisWeight * sample.alphaBand * sample.anchorGuard * sceneWeight;
      if (sample.sceneGuard >= 0.45) guardedSamples++;
      if (weight < 0.035) continue;
      scoreSum += (sample.lumaResidual * 0.86 + sample.chromaResidual * 0.14) * weight;
      lumaSum += sample.lumaResidual * weight;
      chromaSum += sample.chromaResidual * weight;
      weightSum += weight;
      samples++;
    }
  }

  return {
    score: weightSum ? scoreSum / weightSum : 0,
    luma: weightSum ? lumaSum / weightSum : 0,
    chroma: weightSum ? chromaSum / weightSum : 0,
    samples,
    guardedSamples,
    centroidX
  };
}

function applyCenterSeamPass(image, alphaMap, before, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.55), 0, 0.72);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 14), 4, 20);
  const centroidX = before.centroidX;
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0;
  let candidatePixels = 0;
  let guardedPixels = 0;
  let blendSum = 0;
  let lumaDeltaSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    const minX = Math.max(2, Math.floor(centroidX - (options.halfWidth ?? 3.0) - 1));
    const maxX = Math.min(image.width - 3, Math.ceil(centroidX + (options.halfWidth ?? 3.0) + 1));
    for (let x = minX; x <= maxX; x++) {
      const sample = seamSample(image, alphaMap, centroidX, x, y, options);
      if (!sample) continue;
      candidatePixels++;
      if (sample.sceneGuard >= 0.45) guardedPixels++;
      const sceneWeight = 1 - sample.sceneGuard * 0.97;
      const residualSignal = sample.lumaResidual + sample.chromaResidual * 0.12;
      const residualGate = smoothstep(options.residualSoft ?? 0.65, options.residualHard ?? 7.5, residualSignal);
      const blend = Math.min(
        options.maxBlend ?? 0.42,
        strength * sample.axisWeight * sample.alphaBand * sample.anchorGuard * sceneWeight * residualGate
      );
      if (blend < 0.022) continue;

      const yDelta = clamp(sample.wanted[0] - sample.current[0], -maxLumaDelta, maxLumaDelta) * blend;
      const chromaBlend = Math.min(0.12, blend * 0.24);
      const cb = sample.current[1] + clamp(sample.wanted[1] - sample.current[1], -9, 9) * chromaBlend;
      const cr = sample.current[2] + clamp(sample.wanted[2] - sample.current[2], -9, 9) * chromaBlend;
      const rgb = ycbcrToRgb(sample.current[0] + yDelta, cb, cr);
      out[sample.index] = rgb[0];
      out[sample.index + 1] = rgb[1];
      out[sample.index + 2] = rgb[2];
      correctedPixels++;
      blendSum += blend;
      lumaDeltaSum += Math.abs(yDelta);
    }
  }

  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    candidatePixels,
    guardedPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanAbsLumaDelta: correctedPixels ? lumaDeltaSum / correctedPixels : 0
  };
}

export function applyCenterSeamSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      centerSeam: { enabled: false, attempted: false, accepted: false }
    };
  }

  const before = measureCenterSeamResidual(image, alphaMap, options);
  const outerBefore = measurePostCleanupResidual(image, alphaMap);
  const minSamples = Number.isFinite(options.minSamples) ? options.minSamples : 6;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.62;
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
        improvement: 0,
        correctedPixels: 0,
        candidatePixels: 0,
        guardedPixels: before.guardedSamples || 0
      }
    };
  }

  const pass = applyCenterSeamPass(image, alphaMap, before, options);
  const candidateAfter = measureCenterSeamResidual(pass.image, alphaMap, { ...options, centroidX: before.centroidX });
  const outerCandidateAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - candidateAfter.score) / before.score : 0;
  const minImprovement = Number.isFinite(options.minImprovement) ? options.minImprovement : 0.008;
  const accepted = pass.correctedPixels > 0
    && improvement >= minImprovement
    && candidateAfter.score <= before.score * 0.992
    && outerCandidateAfter.total <= outerBefore.total * 1.005
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
      candidatePixels: pass.candidatePixels,
      candidateCorrectedPixels: pass.correctedPixels,
      guardedPixels: pass.guardedPixels,
      meanBlend: accepted ? pass.meanBlend : 0,
      meanAbsLumaDelta: accepted ? pass.meanAbsLumaDelta : 0
    }
  };
}

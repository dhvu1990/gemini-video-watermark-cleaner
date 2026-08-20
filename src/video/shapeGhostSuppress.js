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

function localHighPass(image, x, y) {
  if (x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1) return 0;
  let sum = 0;
  let weight = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const w = dx === 0 && dy === 0 ? 0 : (dx === 0 || dy === 0 ? 2 : 1);
      const i = ((y + dy) * image.width + x + dx) * 4;
      sum += luma([image.data[i], image.data[i + 1], image.data[i + 2]]) * w;
      weight += w;
    }
  }
  const idx = (y * image.width + x) * 4;
  const center = luma([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
  return weight ? center - sum / weight : 0;
}

function findCleanAnchor(image, alphaMap, x, y, nx, ny, sign, maxRadius = 26) {
  for (let distance = 1; distance <= maxRadius; distance++) {
    const sx = Math.round(x + nx * distance * sign);
    const sy = Math.round(y + ny * distance * sign);
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) break;
    const p = sy * image.width + sx;
    if ((alphaMap[p] || 0) <= 0.006) {
      const i = p * 4;
      return {
        distance,
        x: sx,
        y: sy,
        rgb: [image.data[i], image.data[i + 1], image.data[i + 2]],
        highPass: localHighPass(image, sx, sy)
      };
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
  const texture = (a.highPass * b.distance + b.highPass * a.distance) / span;
  const textureAgreement = 1 - smoothstep(4, 22, Math.abs(a.highPass - b.highPass));
  const textureEnergy = Math.min(24, (Math.abs(a.highPass) + Math.abs(b.highPass)) * 0.5);
  return { rgb, disagreement, span, texture, textureAgreement, textureEnergy };
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

function analyzeGhostField(image, alphaMap, options = {}) {
  let gradientSum = 0, disagreementSum = 0, textureSum = 0, lumaSum = 0, count = 0;
  for (let y = 2; y < image.height - 2; y += 2) {
    for (let x = 2; x < image.width - 2; x += 2) {
      const sample = ghostSample(image, alphaMap, x, y, options);
      if (!sample) continue;
      gradientSum += sample.ig.magnitude;
      disagreementSum += sample.target.disagreement;
      textureSum += sample.target.textureEnergy * sample.target.textureAgreement;
      lumaSum += sample.current[0];
      count++;
    }
  }
  const meanGradient = count ? gradientSum / count : 0;
  const meanAnchorDisagreement = count ? disagreementSum / count : 0;
  const meanTextureEnergy = count ? textureSum / count : 0;
  const meanLuma = count ? lumaSum / count : 0;
  const smoothConfidence = count
    ? (1 - smoothstep(3.5, 9.5, meanGradient)) * (1 - smoothstep(12, 34, meanAnchorDisagreement))
    : 0;
  const texturedConfidence = count
    ? smoothstep(3.0, 11.0, meanTextureEnergy) * (1 - smoothstep(42, 82, meanAnchorDisagreement))
    : 0;
  const lightSurfaceSupport = Math.max(smoothConfidence, texturedConfidence * 0.70);
  const lightConfidence = count
    ? smoothstep(150, 220, meanLuma)
      * (0.40 + lightSurfaceSupport * 0.60)
      * (1 - smoothstep(58, 96, meanAnchorDisagreement))
    : 0;
  return {
    samples: count,
    meanGradient,
    meanAnchorDisagreement,
    meanTextureEnergy,
    meanLuma,
    smoothConfidence,
    texturedConfidence,
    lightConfidence
  };
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
  const smoothMicro = clamp(Number(options.smoothMicro ?? 0), 0, 1);
  const textureRestore = clamp(Number(options.textureRestore ?? 0.42), 0, 0.70);
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, blendSum = 0, lumaDeltaSum = 0, darkBoostedPixels = 0, lightMicroPixels = 0, textureRestoredPixels = 0, microGhostPixels = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const sample = ghostSample(image, alphaMap, x, y, options);
      if (!sample) continue;
      if (sample.target.disagreement > (options.maxAnchorDisagreement ?? 76)) continue;

      const alignmentGate = smoothstep(0.38, 0.88, sample.alignment);
      const standardResidual = smoothstep(1.2, 10.5, sample.lumaResidual + sample.chromaResidual * 0.22);
      const microResidual = smoothstep(0.28, 2.8, sample.lumaResidual + sample.chromaResidual * 0.18) * (1 - smoothstep(5.0, 9.0, sample.lumaResidual));
      const residualGate = Math.max(standardResidual, microResidual * smoothMicro * 0.72);
      const anchorGate = 1 - smoothstep(30, 78, sample.target.disagreement);
      const spanGate = 1 - smoothstep(26, 46, sample.target.span);
      const bodyBand = smoothstep(0.085, 0.20, sample.alpha) * (1 - smoothstep(0.54, 0.70, sample.alpha));
      const sceneStructureGuard = smoothstep(18, 58, sample.ig.magnitude) * (1 - alignmentGate * 0.86);
      const darkConfidence = (1 - smoothstep(48, 132, sample.current[0])) * alignmentGate * anchorGate;
      const lightConfidence = smoothstep(150, 220, sample.current[0]) * alignmentGate * anchorGate;
      const darkBoost = 1 + darkConfidence * 0.24;
      const microBoost = 1
        + smoothMicro * microResidual * anchorGate * 0.20
        + lightConfidence * smoothMicro * microResidual * 0.12;
      const blend = Math.min(0.46, strength * darkBoost * microBoost * bodyBand * residualGate * anchorGate * spanGate * (0.30 + alignmentGate * 0.70) * (1 - sceneStructureGuard * 0.88));
      if (blend < 0.024) continue;

      const textureGate = smoothstep(2.5, 12.0, sample.target.textureEnergy)
        * sample.target.textureAgreement
        * (1 - smoothstep(0.62, 0.94, sample.alignment))
        * anchorGate;
      const textureDelta = clamp(sample.target.texture, -10, 10) * textureRestore * textureGate;
      const wantedY = sample.wanted[0] + textureDelta;
      const yDelta = clamp(wantedY - sample.current[0], -18, 18) * blend;
      const chromaScale = 0.32 - lightConfidence * 0.14;
      const chromaBlend = Math.min(0.18, blend * chromaScale);
      const cb = sample.current[1] + clamp(sample.wanted[1] - sample.current[1], -15, 15) * chromaBlend;
      const cr = sample.current[2] + clamp(sample.wanted[2] - sample.current[2], -15, 15) * chromaBlend;
      const rgb = ycbcrToRgb(sample.current[0] + yDelta, cb, cr);
      out[sample.idx] = rgb[0]; out[sample.idx + 1] = rgb[1]; out[sample.idx + 2] = rgb[2];
      correctedPixels++;
      if (darkConfidence > 0.20) darkBoostedPixels++;
      if (lightConfidence > 0.25 && microResidual > standardResidual) lightMicroPixels++;
      if (Math.abs(textureDelta) > 0.35) textureRestoredPixels++;
      if (smoothMicro > 0.20 && microResidual > standardResidual) microGhostPixels++;
      blendSum += blend;
      lumaDeltaSum += Math.abs(yDelta);
    }
  }

  return {
    image: { width: image.width, height: image.height, data: out },
    correctedPixels,
    darkBoostedPixels,
    lightMicroPixels,
    textureRestoredPixels,
    microGhostPixels,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanAbsLumaDelta: correctedPixels ? lumaDeltaSum / correctedPixels : 0
  };
}

export function applyShapeGhostSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || alphaMap.length !== image.width * image.height) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), shapeGhost: { enabled: false, attempted: false, accepted: false } };
  }

  const before = measureShapeGhostResidual(image, alphaMap, options);
  const field = analyzeGhostField(image, alphaMap, options);
  const outerBefore = measurePostCleanupResidual(image, alphaMap);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1.35;
  const smoothMicroEligible = field.samples >= 8
    && field.smoothConfidence >= 0.52
    && before.score >= (options.microMinScore ?? 0.42);
  const lightMicroEligible = field.samples >= 8
    && field.lightConfidence >= (options.lightMicroConfidence ?? 0.28)
    && before.score >= (options.lightMicroMinScore ?? 0.30);
  const microEligible = smoothMicroEligible || lightMicroEligible;
  if (before.samples < (options.minSamples ?? 8) || (before.score < minScore && !microEligible)) {
    return {
      width: image.width, height: image.height, data: new Uint8ClampedArray(image.data),
      shapeGhost: {
        enabled: true,
        attempted: false,
        accepted: false,
        before,
        after: before,
        outerBefore,
        outerAfter: outerBefore,
        improvement: 0,
        correctedPixels: 0,
        field,
        microEligible,
        smoothMicroEligible,
        lightMicroEligible
      }
    };
  }

  const microStrength = microEligible
    ? Math.max(field.smoothConfidence, lightMicroEligible ? field.lightConfidence * 0.90 : 0)
    : 0;
  const passOptions = {
    ...options,
    smoothMicro: microStrength,
    textureRestore: (options.textureRestore ?? 0.42)
      * (0.45 + field.texturedConfidence * 0.55)
      * (lightMicroEligible ? 0.84 : 1)
  };
  const pass = applyShapeGhostPass(image, alphaMap, passOptions);
  const candidateAfter = measureShapeGhostResidual(pass.image, alphaMap, options);
  const outerCandidateAfter = measurePostCleanupResidual(pass.image, alphaMap);
  const improvement = before.score > 1e-6 ? (before.score - candidateAfter.score) / before.score : 0;
  const requiredImprovement = lightMicroEligible
    ? (options.lightMicroMinImprovement ?? 0.004)
    : (microEligible ? (options.microMinImprovement ?? 0.006) : (options.minImprovement ?? 0.012));
  const scoreRatio = lightMicroEligible ? 0.996 : (microEligible ? 0.994 : 0.988);
  const accepted = pass.correctedPixels > 0
    && improvement >= requiredImprovement
    && candidateAfter.score <= before.score * scoreRatio
    && outerCandidateAfter.total <= outerBefore.total * 1.006
    && outerCandidateAfter.luma <= outerBefore.luma * 1.010
    && outerCandidateAfter.chroma <= outerBefore.chroma * (lightMicroEligible ? 1.006 : 1.012);

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
      requiredImprovement,
      correctedPixels: accepted ? pass.correctedPixels : 0,
      candidatePixels: pass.correctedPixels,
      darkBoostedPixels: accepted ? pass.darkBoostedPixels : 0,
      candidateDarkBoostedPixels: pass.darkBoostedPixels,
      lightMicroPixels: accepted ? pass.lightMicroPixels : 0,
      candidateLightMicroPixels: pass.lightMicroPixels,
      textureRestoredPixels: accepted ? pass.textureRestoredPixels : 0,
      candidateTextureRestoredPixels: pass.textureRestoredPixels,
      microGhostPixels: accepted ? pass.microGhostPixels : 0,
      candidateMicroGhostPixels: pass.microGhostPixels,
      meanBlend: accepted ? pass.meanBlend : 0,
      meanAbsLumaDelta: accepted ? pass.meanAbsLumaDelta : 0,
      field,
      microStrength,
      microEligible,
      smoothMicroEligible,
      lightMicroEligible
    }
  };
}
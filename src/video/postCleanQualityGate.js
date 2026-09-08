import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pixelLuma(image, p) {
  const i = p * 4;
  return luma(image.data[i], image.data[i + 1], image.data[i + 2]);
}

function cloneImage(image) {
  return { ...image, data: new Uint8ClampedArray(image.data) };
}

function supportMask(alphaMap, threshold) {
  const mask = new Uint8Array(alphaMap.length);
  let count = 0;
  for (let p = 0; p < alphaMap.length; p++) {
    if (finite(alphaMap[p], 0) >= threshold) {
      mask[p] = 1;
      count++;
    }
  }
  return { mask, count };
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return new Uint8Array(mask);
  let current = new Uint8Array(mask);
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(current);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!current[p]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            next[yy * width + xx] = 1;
          }
        }
      }
    }
    current = next;
  }
  return current;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, r) => [...row, vector[r]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-8) return null;
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function basisAt(x, y, width, height) {
  const nx = width > 1 ? (x / (width - 1)) * 2 - 1 : 0;
  const ny = height > 1 ? (y / (height - 1)) * 2 - 1 : 0;
  return [1, nx, ny, nx * ny, nx * nx, ny * ny];
}

function fitChannel(samples, channel, width, height, weights = null) {
  const terms = 6;
  const normal = Array.from({ length: terms }, () => Array(terms).fill(0));
  const rhs = Array(terms).fill(0);
  for (let s = 0; s < samples.length; s++) {
    const sample = samples[s];
    const b = basisAt(sample.x, sample.y, width, height);
    const w = weights ? weights[s] : 1;
    const value = sample.rgb[channel];
    for (let i = 0; i < terms; i++) {
      rhs[i] += w * b[i] * value;
      for (let j = i; j < terms; j++) normal[i][j] += w * b[i] * b[j];
    }
  }
  for (let i = 0; i < terms; i++) {
    normal[i][i] += 1e-5;
    for (let j = 0; j < i; j++) normal[i][j] = normal[j][i];
  }
  return solveLinearSystem(normal, rhs);
}

function predict(coefficients, x, y, width, height) {
  const b = basisAt(x, y, width, height);
  return coefficients.map((channel) => {
    let value = 0;
    for (let i = 0; i < b.length; i++) value += channel[i] * b[i];
    return clamp(value, 0, 255);
  });
}

function collectAnnulusSamples(image, alphaMap, support, width, height, options) {
  const innerRadius = Math.max(1, Math.round(finite(options.donorInnerRadius, 4)));
  const outerRadius = Math.max(innerRadius + 2, Math.round(finite(options.donorOuterRadius, 12)));
  const inner = dilateMask(support, width, height, innerRadius);
  const outer = dilateMask(support, width, height, outerRadius);
  const maxDonorAlpha = finite(options.maxDonorAlpha, 0.004);
  const samples = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (!outer[p] || inner[p] || finite(alphaMap[p], 0) > maxDonorAlpha) continue;
      const i = p * 4;
      samples.push({ x, y, p, rgb: [image.data[i], image.data[i + 1], image.data[i + 2]] });
    }
  }
  return { samples, inner, outer, innerRadius, outerRadius };
}

function fitRobustSurface(samples, width, height) {
  if (samples.length < 24) return null;
  let weights = null;
  let coefficients = null;
  for (let iteration = 0; iteration < 3; iteration++) {
    coefficients = [0, 1, 2].map((channel) => fitChannel(samples, channel, width, height, weights));
    if (coefficients.some((item) => !item)) return null;
    const residuals = samples.map((sample) => {
      const predicted = predict(coefficients, sample.x, sample.y, width, height);
      return Math.abs(luma(...sample.rgb) - luma(...predicted));
    });
    const sorted = [...residuals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const scale = Math.max(1.5, median * 1.4826);
    weights = residuals.map((residual) => {
      const ratio = residual / (2.5 * scale);
      return ratio <= 1 ? 1 : 1 / ratio;
    });
  }
  let lumaMae = 0;
  let rgbMae = 0;
  for (const sample of samples) {
    const predicted = predict(coefficients, sample.x, sample.y, width, height);
    lumaMae += Math.abs(luma(...sample.rgb) - luma(...predicted));
    rgbMae += (Math.abs(sample.rgb[0] - predicted[0]) + Math.abs(sample.rgb[1] - predicted[1]) + Math.abs(sample.rgb[2] - predicted[2])) / 3;
  }
  return { coefficients, lumaMae: lumaMae / samples.length, rgbMae: rgbMae / samples.length };
}

function annulusGradientStats(image, samples) {
  const width = image.width;
  const height = image.height;
  if (!samples.length) return { mean: Infinity, highDensity: 1, samples: 0 };
  let sum = 0;
  let high = 0;
  let count = 0;
  const highThreshold = 22;
  for (const sample of samples) {
    const { x, y } = sample;
    if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) continue;
    const gx = Math.abs(pixelLuma(image, y * width + x + 1) - pixelLuma(image, y * width + x - 1)) * 0.5;
    const gy = Math.abs(pixelLuma(image, (y + 1) * width + x) - pixelLuma(image, (y - 1) * width + x)) * 0.5;
    const gradient = Math.hypot(gx, gy);
    sum += gradient;
    if (gradient >= highThreshold) high++;
    count++;
  }
  return { mean: count ? sum / count : Infinity, highDensity: count ? high / count : 1, samples: count };
}

function localHighPass(image, x, y) {
  const width = image.width;
  const height = image.height;
  const centerP = y * width + x;
  const center = [image.data[centerP * 4], image.data[centerP * 4 + 1], image.data[centerP * 4 + 2]];
  const mean = [0, 0, 0];
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = clamp(y + dy, 0, height - 1);
    for (let dx = -1; dx <= 1; dx++) {
      const xx = clamp(x + dx, 0, width - 1);
      const i = (yy * width + xx) * 4;
      mean[0] += image.data[i];
      mean[1] += image.data[i + 1];
      mean[2] += image.data[i + 2];
      count++;
    }
  }
  return center.map((value, channel) => value - mean[channel] / count);
}

function contourStrength(alphaMap, width, height, p) {
  const x = p % width;
  const y = Math.floor(p / width);
  const center = finite(alphaMap[p], 0);
  let gradient = 0;
  if (x > 0) gradient = Math.max(gradient, Math.abs(center - finite(alphaMap[p - 1], 0)));
  if (x + 1 < width) gradient = Math.max(gradient, Math.abs(center - finite(alphaMap[p + 1], 0)));
  if (y > 0) gradient = Math.max(gradient, Math.abs(center - finite(alphaMap[p - width], 0)));
  if (y + 1 < height) gradient = Math.max(gradient, Math.abs(center - finite(alphaMap[p + width], 0)));
  return gradient;
}

function measureQuality(image, alphaMap, model, support, expandedSupport, options = {}) {
  const width = image.width;
  const height = image.height;
  const supportAlpha = finite(options.supportAlpha, 0.006);
  const coreAlpha = finite(options.coreAlpha, 0.08);
  const contourMinAlpha = finite(options.contourMinAlpha, 0.004);
  const contourMaxAlpha = finite(options.contourMaxAlpha, 0.34);
  let modelSum = 0;
  let modelWeight = 0;
  let boundarySum = 0;
  let boundaryWeight = 0;
  let contourSum = 0;
  let contourWeight = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const alpha = finite(alphaMap[p], 0);
      if (!expandedSupport[p]) continue;
      const predicted = predict(model.coefficients, x, y, width, height);
      const observedLuma = pixelLuma(image, p);
      const predictedLuma = luma(...predicted);
      const mismatch = Math.abs(observedLuma - predictedLuma);
      if (alpha >= coreAlpha) {
        const w = 0.35 + 0.65 * clamp(alpha, 0, 1);
        modelSum += mismatch * w;
        modelWeight += w;
      } else if (alpha >= supportAlpha || support[p]) {
        modelSum += mismatch * 0.35;
        modelWeight += 0.35;
      }
      if ((alpha >= contourMinAlpha && alpha <= contourMaxAlpha) || (!support[p] && expandedSupport[p])) {
        const gradA = contourStrength(alphaMap, width, height, p);
        const w = 0.25 + clamp(gradA * 6, 0, 1.5);
        boundarySum += mismatch * w;
        boundaryWeight += w;
        const gx = Math.abs(pixelLuma(image, p + 1) - pixelLuma(image, p - 1)) * 0.5;
        const gy = Math.abs(pixelLuma(image, p + width) - pixelLuma(image, p - width)) * 0.5;
        contourSum += Math.hypot(gx, gy) * w;
        contourWeight += w;
      }
    }
  }
  const modelMismatch = modelWeight ? modelSum / modelWeight : 0;
  const boundaryMismatch = boundaryWeight ? boundarySum / boundaryWeight : 0;
  const contourResidual = contourWeight ? contourSum / contourWeight : 0;
  const score = modelMismatch + boundaryMismatch * 0.72 + contourResidual * 0.18;
  return { modelMismatch, boundaryMismatch, contourResidual, score, samples: Math.round(modelWeight + boundaryWeight) };
}

function buildCandidate(image, alphaMap, model, support, expandedSupport, options = {}) {
  const result = cloneImage(image);
  const width = image.width;
  const height = image.height;
  const supportAlpha = finite(options.supportAlpha, 0.006);
  const coreAlpha = finite(options.coreAlpha, 0.08);
  const baseStrength = clamp(finite(options.strength, 0.78), 0, 1);
  const exteriorStrength = clamp(finite(options.exteriorStrength, 0.46), 0, 1);
  const regrainStrength = clamp(finite(options.regrainStrength, 0.30), 0, 1);
  const maxHighPass = finite(options.maxHighPass, 3.0);
  const maxChannelDelta = finite(options.maxChannelDelta, 36);
  const mismatchSoft = finite(options.mismatchSoft, 3.0);
  const mismatchHard = Math.max(mismatchSoft + 1, finite(options.mismatchHard, 16));
  let correctedPixels = 0;
  let blendSum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (!expandedSupport[p]) continue;
      const alpha = finite(alphaMap[p], 0);
      const direct = support[p] || alpha >= supportAlpha;
      const predicted = predict(model.coefficients, x, y, width, height);
      const i = p * 4;
      const current = [image.data[i], image.data[i + 1], image.data[i + 2]];
      const mismatch = Math.abs(luma(...current) - luma(...predicted));
      const mismatchFactor = clamp((mismatch - mismatchSoft) / (mismatchHard - mismatchSoft), 0, 1);
      if (!direct && mismatchFactor < 0.25) continue;
      const hp = localHighPass(image, x, y).map((value) => clamp(value, -maxHighPass, maxHighPass));
      const target = predicted.map((value, channel) => clamp(value + hp[channel] * regrainStrength, 0, 255));
      const alphaFactor = direct
        ? clamp(0.48 + 0.52 * Math.sqrt(clamp(alpha / Math.max(coreAlpha, 1e-5), 0, 1)), 0, 1)
        : 0;
      const strength = direct
        ? baseStrength * (0.68 + 0.32 * Math.max(alphaFactor, mismatchFactor))
        : exteriorStrength * mismatchFactor;
      if (strength <= 0.02) continue;
      for (let channel = 0; channel < 3; channel++) {
        const delta = clamp(target[channel] - current[channel], -maxChannelDelta, maxChannelDelta);
        result.data[i + channel] = clamp(Math.round(current[channel] + delta * strength), 0, 255);
      }
      correctedPixels++;
      blendSum += strength;
    }
  }
  return { image: result, correctedPixels, meanBlend: correctedPixels ? blendSum / correctedPixels : 0 };
}

export function evaluatePostCleanQualityGate(image, alphaMap, options = {}) {
  const width = image?.width || 0;
  const height = image?.height || 0;
  const invalid = !image?.data || !alphaMap || alphaMap.length !== width * height || width < 5 || height < 5;
  if (invalid) {
    return { eligible: false, reason: 'invalid-input', model: null, scene: null, before: null };
  }
  const supportAlpha = finite(options.supportAlpha, 0.006);
  const { mask: support, count: supportPixels } = supportMask(alphaMap, supportAlpha);
  if (supportPixels < Math.max(8, Math.round(finite(options.minSupportPixels, 18)))) {
    return { eligible: false, reason: 'insufficient-support', supportPixels, model: null, scene: null, before: null };
  }
  const annulus = collectAnnulusSamples(image, alphaMap, support, width, height, options);
  const minDonors = Math.max(24, Math.round(finite(options.minDonorSamples, 48)));
  if (annulus.samples.length < minDonors) {
    return { eligible: false, reason: 'insufficient-donor-annulus', supportPixels, donorSamples: annulus.samples.length, model: null, scene: null, before: null };
  }
  const model = fitRobustSurface(annulus.samples, width, height);
  if (!model) {
    return { eligible: false, reason: 'surface-fit-failed', supportPixels, donorSamples: annulus.samples.length, model: null, scene: null, before: null };
  }
  const scene = annulusGradientStats(image, annulus.samples);
  const sceneEdge = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});
  const maxModelMae = finite(options.maxModelMae, 7.8);
  const maxRgbMae = finite(options.maxRgbMae, 9.8);
  const maxMeanGradient = finite(options.maxMeanGradient, 9.5);
  const maxHighGradientDensity = finite(options.maxHighGradientDensity, 0.09);
  const maxSceneEdgeScore = finite(options.maxSceneEdgeScore, 0.30);
  const smoothEligible = model.lumaMae <= maxModelMae
    && model.rgbMae <= maxRgbMae
    && scene.mean <= maxMeanGradient
    && scene.highDensity <= maxHighGradientDensity
    && !sceneEdge.protect
    && sceneEdge.level !== 'high'
    && finite(sceneEdge.score, 1) <= maxSceneEdgeScore;
  const haloRadius = Math.max(1, Math.round(finite(options.haloRadius, 3)));
  const expandedSupport = dilateMask(support, width, height, haloRadius);
  const before = measureQuality(image, alphaMap, model, support, expandedSupport, options);
  return {
    eligible: options.enabled !== false && smoothEligible,
    reason: options.enabled === false ? 'disabled' : (smoothEligible ? 'smooth-annulus' : 'structured-or-unsafe-annulus'),
    supportPixels,
    donorSamples: annulus.samples.length,
    model,
    scene,
    sceneEdge,
    before,
    support,
    expandedSupport
  };
}

export function applyPostCleanQualityGate(image, alphaMap, options = {}) {
  const evaluation = evaluatePostCleanQualityGate(image, alphaMap, options);
  const baseDiagnostics = {
    attempted: false,
    accepted: false,
    reason: evaluation.reason,
    detectionConfidence: Number.isFinite(Number(options.detectionConfidence)) ? clamp(Number(options.detectionConfidence), 0, 1) : null,
    supportPixels: evaluation.supportPixels || 0,
    donorSamples: evaluation.donorSamples || 0,
    surfaceLumaMae: evaluation.model?.lumaMae ?? null,
    surfaceRgbMae: evaluation.model?.rgbMae ?? null,
    annulusMeanGradient: evaluation.scene?.mean ?? null,
    annulusHighGradientDensity: evaluation.scene?.highDensity ?? null,
    sceneEdgeRisk: evaluation.sceneEdge || null,
    before: evaluation.before || null,
    candidate: null,
    correctedPixels: 0,
    meanBlend: 0,
    qualityImprovement: 0,
    selectedCandidate: 'baseline'
  };
  if (!evaluation.eligible) {
    return { ...image, postCleanQualityGate: baseDiagnostics };
  }
  const minBeforeScore = finite(options.minBeforeScore, 4.8);
  const minModelMismatch = finite(options.minModelMismatch, 3.6);
  const minBoundaryMismatch = finite(options.minBoundaryMismatch, 3.2);
  const needsRescue = evaluation.before.score >= minBeforeScore
    && (evaluation.before.modelMismatch >= minModelMismatch || evaluation.before.boundaryMismatch >= minBoundaryMismatch);
  if (!needsRescue) {
    return {
      ...image,
      postCleanQualityGate: { ...baseDiagnostics, reason: 'baseline-quality-good' }
    };
  }
  const candidateBuild = buildCandidate(
    image,
    alphaMap,
    evaluation.model,
    evaluation.support,
    evaluation.expandedSupport,
    options
  );
  const candidate = measureQuality(
    candidateBuild.image,
    alphaMap,
    evaluation.model,
    evaluation.support,
    evaluation.expandedSupport,
    options
  );
  const beforeScore = evaluation.before.score;
  const improvement = beforeScore > 1e-6 ? (beforeScore - candidate.score) / beforeScore : 0;
  const modelSafe = candidate.modelMismatch <= evaluation.before.modelMismatch * finite(options.maxModelMismatchRatio, 0.96) + 0.15;
  const boundarySafe = candidate.boundaryMismatch <= evaluation.before.boundaryMismatch * finite(options.maxBoundaryMismatchRatio, 0.98) + 0.20;
  const contourSafe = candidate.contourResidual <= evaluation.before.contourResidual * finite(options.maxContourResidualRatio, 1.04) + 0.25;
  const enoughPixels = candidateBuild.correctedPixels >= Math.max(4, Math.round(finite(options.minCorrectedPixels, 10)));
  const accepted = enoughPixels
    && improvement >= finite(options.minQualityImprovement, 0.08)
    && modelSafe
    && boundarySafe
    && contourSafe;
  const diagnostics = {
    ...baseDiagnostics,
    attempted: true,
    accepted,
    reason: accepted ? 'quality-gate-selected-smooth-candidate' : 'candidate-rejected',
    candidate,
    correctedPixels: candidateBuild.correctedPixels,
    meanBlend: candidateBuild.meanBlend,
    qualityImprovement: improvement,
    modelSafe,
    boundarySafe,
    contourSafe,
    selectedCandidate: accepted ? 'annulus-surface-regrain' : 'baseline'
  };
  if (!accepted) return { ...image, postCleanQualityGate: diagnostics };
  return { ...image, data: candidateBuild.image.data, postCleanQualityGate: diagnostics };
}

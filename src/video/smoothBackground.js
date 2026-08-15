function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function lumaAt(data, index) {
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

function localMaxAlpha(alphaMap, width, height, x, y, radius = 2) {
  let max = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      max = Math.max(max, alphaMap[yy * width + xx] || 0);
    }
  }
  return max;
}

function normalizedBasis(x, y, width, height) {
  const hx = Math.max(1, (width - 1) * 0.5);
  const hy = Math.max(1, (height - 1) * 0.5);
  const nx = (x - (width - 1) * 0.5) / hx;
  const ny = (y - (height - 1) * 0.5) / hy;
  return [1, nx, ny, nx * nx, nx * ny, ny * ny];
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
    for (let k = col; k <= n; k++) a[col][k] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row) => row[n]);
}

function evaluateSurface(coefficients, basis, channel) {
  const c = coefficients[channel];
  let value = 0;
  for (let i = 0; i < basis.length; i++) value += c[i] * basis[i];
  return value;
}

function exteriorSample(alphaMap, width, height, x, y) {
  return (alphaMap[y * width + x] || 0) <= 0.0025
    && localMaxAlpha(alphaMap, width, height, x, y, 2) <= 0.0035;
}

export function fitSmoothBackgroundSurface(image, alphaMap) {
  const { width, height, data } = image;
  if (!alphaMap || alphaMap.length !== width * height) return null;
  const size = 6;
  const ata = Array.from({ length: size }, () => Array(size).fill(0));
  const atb = Array.from({ length: 3 }, () => Array(size).fill(0));
  const samples = [];

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (!exteriorSample(alphaMap, width, height, x, y)) continue;
      const basis = normalizedBasis(x, y, width, height);
      const index = (y * width + x) * 4;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) ata[r][c] += basis[r] * basis[c];
        for (let channel = 0; channel < 3; channel++) atb[channel][r] += basis[r] * data[index + channel];
      }
      samples.push({ x, y, basis });
    }
  }

  const minimumSamples = Math.max(80, Math.round(width * height * 0.12));
  if (samples.length < minimumSamples) return null;
  const coefficients = atb.map((vector) => solveLinearSystem(ata, vector));
  if (coefficients.some((value) => !value)) return null;

  let residualSum = 0;
  let residualCount = 0;
  let gradientSum = 0;
  let laplacianSum = 0;
  let gradientSamples = 0;
  let edgePixels = 0;

  for (const sample of samples) {
    const { x, y, basis } = sample;
    const index = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      residualSum += Math.abs(data[index + channel] - evaluateSurface(coefficients, basis, channel));
      residualCount++;
    }
    if (!exteriorSample(alphaMap, width, height, x - 1, y)
      || !exteriorSample(alphaMap, width, height, x + 1, y)
      || !exteriorSample(alphaMap, width, height, x, y - 1)
      || !exteriorSample(alphaMap, width, height, x, y + 1)) continue;
    const left = lumaAt(data, (y * width + x - 1) * 4);
    const right = lumaAt(data, (y * width + x + 1) * 4);
    const up = lumaAt(data, ((y - 1) * width + x) * 4);
    const down = lumaAt(data, ((y + 1) * width + x) * 4);
    const center = lumaAt(data, index);
    const gradient = Math.hypot((right - left) * 0.5, (down - up) * 0.5);
    const laplacian = Math.abs(left + right + up + down - center * 4);
    gradientSum += gradient;
    laplacianSum += laplacian;
    gradientSamples++;
    if (gradient >= 14) edgePixels++;
  }

  let coreSamples = 0;
  let coreStructure = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      if (a < 0.08) continue;
      const index = p * 4;
      const left = lumaAt(data, index - 4);
      const right = lumaAt(data, index + 4);
      const up = lumaAt(data, index - width * 4);
      const down = lumaAt(data, index + width * 4);
      const gx = (right - left) * 0.5;
      const gy = (down - up) * 0.5;
      const imageGradient = Math.hypot(gx, gy);
      const agx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const agy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const alphaGradient = Math.hypot(agx, agy);
      let alignment = 0;
      if (imageGradient > 1e-6 && alphaGradient > 1e-6) {
        alignment = Math.abs((gx * agx + gy * agy) / (imageGradient * alphaGradient));
      }
      coreSamples++;
      if (imageGradient >= 18 && (alphaGradient < 0.0015 || alignment < 0.52)) coreStructure++;
    }
  }

  const surfaceMae = residualCount ? residualSum / residualCount : Number.POSITIVE_INFINITY;
  const meanGradient = gradientSamples ? gradientSum / gradientSamples : Number.POSITIVE_INFINITY;
  const meanLaplacian = gradientSamples ? laplacianSum / gradientSamples : Number.POSITIVE_INFINITY;
  const edgeDensity = gradientSamples ? edgePixels / gradientSamples : 1;
  const coreStructureDensity = coreSamples ? coreStructure / coreSamples : 1;
  const complexity = clamp(
    clamp(surfaceMae / 14, 0, 1) * 0.30
    + clamp(edgeDensity / 0.18, 0, 1) * 0.25
    + clamp(meanGradient / 14, 0, 1) * 0.15
    + clamp(meanLaplacian / 12, 0, 1) * 0.10
    + clamp(coreStructureDensity / 0.28, 0, 1) * 0.20,
    0,
    1
  );

  return {
    coefficients,
    sampleCount: samples.length,
    surfaceMae,
    meanGradient,
    meanLaplacian,
    edgeDensity,
    coreStructureDensity,
    complexity
  };
}

export function analyzeSmoothBackground(image, alphaMap, options = {}) {
  const fit = fitSmoothBackgroundSurface(image, alphaMap);
  if (!fit) return { safe: false, mode: 'structured', reason: 'insufficient-clean-background-samples' };
  const thresholds = {
    maxComplexity: Number.isFinite(options.maxComplexity) ? options.maxComplexity : 0.43,
    maxSurfaceMae: Number.isFinite(options.maxSurfaceMae) ? options.maxSurfaceMae : 10.5,
    maxEdgeDensity: Number.isFinite(options.maxEdgeDensity) ? options.maxEdgeDensity : 0.13,
    maxMeanGradient: Number.isFinite(options.maxMeanGradient) ? options.maxMeanGradient : 11.5,
    maxMeanLaplacian: Number.isFinite(options.maxMeanLaplacian) ? options.maxMeanLaplacian : 8.5,
    maxCoreStructureDensity: Number.isFinite(options.maxCoreStructureDensity) ? options.maxCoreStructureDensity : 0.24
  };
  const failures = [];
  if (fit.complexity > thresholds.maxComplexity) failures.push('complexity');
  if (fit.surfaceMae > thresholds.maxSurfaceMae) failures.push('surface-fit');
  if (fit.edgeDensity > thresholds.maxEdgeDensity) failures.push('edge-density');
  if (fit.meanGradient > thresholds.maxMeanGradient) failures.push('gradient-energy');
  if (fit.meanLaplacian > thresholds.maxMeanLaplacian) failures.push('high-frequency-energy');
  if (fit.coreStructureDensity > thresholds.maxCoreStructureDensity) failures.push('core-structure');
  return {
    ...fit,
    safe: failures.length === 0,
    mode: failures.length === 0 ? 'smooth-rebuild' : 'structured',
    reason: failures.length ? failures.join(',') : 'smooth-gradient-background',
    thresholds
  };
}

function buildFeatherMask(alphaMap, width, height, dilationRadius = 4) {
  let mask = new Float32Array(alphaMap.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maxAlpha = localMaxAlpha(alphaMap, width, height, x, y, dilationRadius);
      const direct = alphaMap[y * width + x] || 0;
      mask[y * width + x] = Math.max(
        smoothstep(0.002, 0.055, maxAlpha) * 0.84,
        smoothstep(0.004, 0.055, direct)
      );
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    const blurred = new Float32Array(mask.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
            sum += mask[(y + dy) * width + x + dx] * w;
            weight += w;
          }
        }
        blurred[y * width + x] = sum / weight;
      }
    }
    for (let x = 0; x < width; x++) {
      blurred[x] = mask[x];
      blurred[(height - 1) * width + x] = mask[(height - 1) * width + x];
    }
    for (let y = 0; y < height; y++) {
      blurred[y * width] = mask[y * width];
      blurred[y * width + width - 1] = mask[y * width + width - 1];
    }
    mask = blurred;
  }
  return mask;
}

function microSmoothTransition(image, mask, strength = 0.18) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const m = mask[p] || 0;
      const transition = 4 * m * (1 - m);
      const blend = Math.min(0.22, strength * transition);
      if (blend < 0.015) continue;
      const idx = p * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
            sum += data[((y + dy) * width + x + dx) * 4 + c] * w;
            weight += w;
          }
        }
        const average = sum / weight;
        out[idx + c] = clampByte(data[idx + c] * (1 - blend) + average * blend);
      }
    }
  }
  return { width, height, data: out };
}

export function applySmoothBackgroundReconstruction(image, alphaMap, analysis, options = {}) {
  if (!analysis?.safe || !analysis.coefficients || alphaMap.length !== image.width * image.height) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      smoothBackground: { applied: false, ...(analysis || { safe: false, mode: 'structured' }) }
    };
  }

  const strength = clamp(Number(options.strength ?? 0.995), 0, 1);
  const featherMask = buildFeatherMask(alphaMap, image.width, image.height, options.dilationRadius ?? 4);
  const out = new Uint8ClampedArray(image.data);
  let replacedPixels = 0;
  let blendSum = 0;
  let maxBlend = 0;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = y * image.width + x;
      const mask = featherMask[p] || 0;
      if (mask < 0.01) continue;
      const direct = alphaMap[p] || 0;
      const bodyBoost = smoothstep(0.006, 0.06, direct);
      const blend = Math.min(0.995, strength * clamp(mask * 0.92 + bodyBoost * 0.18, 0, 1));
      if (blend < 0.02) continue;
      const basis = normalizedBasis(x, y, image.width, image.height);
      const idx = p * 4;
      for (let c = 0; c < 3; c++) {
        const predicted = clampByte(evaluateSurface(analysis.coefficients, basis, c));
        out[idx + c] = clampByte(image.data[idx + c] * (1 - blend) + predicted * blend);
      }
      replacedPixels++;
      blendSum += blend;
      maxBlend = Math.max(maxBlend, blend);
    }
  }

  const smoothed = microSmoothTransition(
    { width: image.width, height: image.height, data: out },
    featherMask,
    clamp(Number(options.microSmooth ?? 0.18), 0, 0.35)
  );

  return {
    width: smoothed.width,
    height: smoothed.height,
    data: smoothed.data,
    smoothBackground: {
      applied: true,
      safe: true,
      mode: 'smooth-rebuild',
      reason: analysis.reason,
      complexity: analysis.complexity,
      surfaceMae: analysis.surfaceMae,
      edgeDensity: analysis.edgeDensity,
      meanGradient: analysis.meanGradient,
      meanLaplacian: analysis.meanLaplacian,
      coreStructureDensity: analysis.coreStructureDensity,
      sampleCount: analysis.sampleCount,
      replacedPixels,
      meanBlend: replacedPixels ? blendSum / replacedPixels : 0,
      maxBlend
    }
  };
}

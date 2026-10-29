// Only the explicitly recognized visible Veo text uses this repair path.
// Recover its white strokes AND dark outline; keep Gemini diamond untouched.
import { cropRegion, embedAlphaMap, pasteRegion } from './textureRepair.js';
import { applyVeoWordmarkResidualMicroFinish } from './veoWordmarkResidualFinish.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const luma = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function solve6(matrix, right) {
  const n = 6, data = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) data[i * (n + 1) + j] = matrix[i * n + j];
    data[i * (n + 1) + n] = right[i];
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(data[row * (n + 1) + col]) > Math.abs(data[pivot * (n + 1) + col])) pivot = row;
    }
    if (Math.abs(data[pivot * (n + 1) + col]) < 1e-8) return null;
    if (pivot !== col) {
      for (let j = col; j <= n; j++) {
        const a = pivot * (n + 1) + j, b = col * (n + 1) + j;
        const tmp = data[a]; data[a] = data[b]; data[b] = tmp;
      }
    }
    const value = data[col * (n + 1) + col];
    for (let j = col; j <= n; j++) data[col * (n + 1) + j] /= value;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const multiplier = data[row * (n + 1) + col];
      for (let j = col; j <= n; j++) data[row * (n + 1) + j] -= data[col * (n + 1) + j] * multiplier;
    }
  }
  return Array.from({ length: n }, (_, i) => data[i * (n + 1) + n]);
}

function features(x, y, midX, midY, span) {
  const nx = (x - midX) / span, ny = (y - midY) / span;
  return [1, nx, ny, nx * nx, ny * ny, nx * ny];
}

function stencilBounds(alpha, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, support = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((alpha[y * w + x] || 0) < 0.08) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y); support++;
  }
  if (support < 12) return null;
  const padX = Math.max(2, Math.round(w * 0.045));
  const padY = Math.max(2, Math.round(h * 0.06));
  return {
    x0: clamp(x0 - padX, 3, w - 4), x1: clamp(x1 + padX, 3, w - 4),
    y0: clamp(y0 - padY, 3, h - 4), y1: clamp(y1 + padY, 3, h - 4)
  };
}

// Fit the untouched ring only. Robust second-pass weighting prevents isolated
// bokeh highlights from coloring the inferred background through the wordmark.
function robustBackground(image, bounds) {
  const { width: w, height: h, data } = image;
  const midX = (bounds.x0 + bounds.x1) / 2, midY = (bounds.y0 + bounds.y1) / 2;
  const span = Math.max(12, 0.5 * Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0));
  const reach = Math.max(10, Math.min(21, Math.round(w * 0.28)));
  const donors = [];
  for (let y = Math.max(2, bounds.y0 - reach); y <= Math.min(h - 3, bounds.y1 + reach); y++) {
    for (let x = Math.max(2, bounds.x0 - reach); x <= Math.min(w - 3, bounds.x1 + reach); x++) {
      if (x >= bounds.x0 - 2 && x <= bounds.x1 + 2 && y >= bounds.y0 - 2 && y <= bounds.y1 + 2) continue;
      const dx = Math.max(bounds.x0 - x, 0, x - bounds.x1);
      const dy = Math.max(bounds.y0 - y, 0, y - bounds.y1);
      const distance = Math.hypot(dx, dy);
      if (distance > reach) continue;
      const i = (y * w + x) * 4;
      donors.push({
        basis: features(x, y, midX, midY, span),
        rgb: [data[i], data[i + 1], data[i + 2]],
        weight: 1 / (1 + distance * 0.08)
      });
    }
  }
  if (donors.length < 45) return null;
  let fit = null;
  for (let pass = 0; pass < 2; pass++) {
    const a = new Float64Array(36);
    const bs = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
    for (const donor of donors) {
      const f = donor.basis;
      let weight = donor.weight;
      if (pass === 1) {
        const estimate = [0, 1, 2].map(c => fit[c].reduce((z, v, j) => z + v * f[j], 0));
        const diff = luma(...donor.rgb) - luma(...estimate);
        weight *= 1 / (1 + Math.pow(Math.max(0, Math.abs(diff) - 18) / 26, 2));
      }
      for (let j = 0; j < 6; j++) {
        for (let k = 0; k < 6; k++) a[j * 6 + k] += weight * f[j] * f[k];
        for (let c = 0; c < 3; c++) bs[c][j] += weight * f[j] * donor.rgb[c];
      }
    }
    for (let j = 0; j < 6; j++) a[j * 6 + j] += 0.00025 * (j > 2 ? 4 : 1);
    fit = bs.map(b => solve6(a, b));
    if (fit.some(coeff => !coeff)) return null;
  }
  const full = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const f = features(x, y, midX, midY, span), i = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) full[i + c] = clamp(fit[c].reduce((a, v, j) => a + v * f[j], 0), 0, 255);
  }
  let fitMAE = 0, weighted = 0;
  for (const d of donors) {
    let diff = 0;
    for (let c = 0; c < 3; c++) {
      diff += Math.abs(d.rgb[c] - fit[c].reduce((a, v, j) => a + v * d.basis[j], 0)) / 3;
    }
    fitMAE += d.weight * diff; weighted += d.weight;
  }
  return { full, fitMAE: fitMAE / Math.max(1, weighted) };
}

// Real scene edges continuing across both sides of the wordmark box are
// protected: a wordmark cleanup must not erase a light bar, line or text edge.
function crossingSceneStructure(image, bounds) {
  const { width: w, height: h, data } = image;
  const safeX = x => clamp(x, 2, w - 3), safeY = y => clamp(y, 2, h - 3);
  const top = safeY(bounds.y0 - 7), bottom = safeY(bounds.y1 + 7);
  const left = safeX(bounds.x0 - 7), right = safeX(bounds.x1 + 7);
  const gray = (x, y) => {
    const i = (y * w + x) * 4;
    return luma(data[i], data[i + 1], data[i + 2]);
  };
  let vertical = 0, horizontal = 0;
  for (let x = bounds.x0; x <= bounds.x1; x++) {
    const t = gray(x + 1, top) - gray(x - 1, top);
    const b = gray(x + 1, bottom) - gray(x - 1, bottom);
    if (t * b > 0 && Math.abs(t) >= 18 && Math.abs(b) >= 18) vertical++;
  }
  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const l = gray(left, y + 1) - gray(left, y - 1);
    const r = gray(right, y + 1) - gray(right, y - 1);
    if (l * r > 0 && Math.abs(l) >= 18 && Math.abs(r) >= 18) horizontal++;
  }
  return { blocked: vertical >= 2 || horizontal >= 2, vertical, horizontal };
}

// The old stencil is a coarse locator, NOT an inverse-compositing alpha map.
// Re-estimate exact white strokes from each frame and grow only a small local
// halo to include the previously unaddressed dark text shadow.
function deriveStrokeMask(image, background, bounds) {
  const { width: w, height: h, data } = image;
  const evidence = new Uint8Array(w * h);
  const bandCounts = [0, 0, 0]; let seedCount = 0;
  const xSpan = Math.max(1, bounds.x1 - bounds.x0 + 1);
  const brightnessGate = clamp(14 + background.fitMAE * 0.25, 15, 26);
  for (let y = bounds.y0; y <= bounds.y1; y++) for (let x = bounds.x0; x <= bounds.x1; x++) {
    const p = y * w + x, i = p * 4, j = p * 3;
    const observed = luma(data[i], data[i + 1], data[i + 2]);
    const expected = luma(background.full[j], background.full[j + 1], background.full[j + 2]);
    if (observed - expected < brightnessGate) continue;
    evidence[p] = 1; seedCount++;
    const section = clamp(Math.floor((x - bounds.x0) / xSpan * 3), 0, 2);
    bandCounts[section]++;
  }
  const bandFloor = Math.max(3, Math.round(w * 0.07));
  if (seedCount < Math.max(24, Math.round(w * 0.5)) || bandCounts.some(n => n < bandFloor)) {
    return { mask: null, seedCount, bandCounts, reason: 'insufficient-three-letter-evidence' };
  }
  const mask = new Float32Array(w * h), haloRadius = Math.max(2.6, w * 0.045);
  const feather = 1.2, range = Math.ceil(haloRadius + feather);
  for (let y = Math.max(2, bounds.y0 - range); y <= Math.min(h - 3, bounds.y1 + range); y++) {
    for (let x = Math.max(2, bounds.x0 - range); x <= Math.min(w - 3, bounds.x1 + range); x++) {
      let nearest = 1e6;
      for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !evidence[yy * w + xx]) continue;
        const distance = dx * dx + dy * dy;
        if (distance < nearest) nearest = distance;
      }
      const distance = Math.sqrt(nearest);
      mask[y * w + x] = distance <= haloRadius ? 1 : clamp((haloRadius + feather - distance) / feather, 0, 1);
    }
  }
  return { mask, seedCount, bandCounts, reason: 'letter-evidence' };
}

// Gradient-domain reconstruction with a donor strip that is always ABOVE the
// detected text. Dirichlet boundary uses untouched real scene pixels; unlike
// a flat fill, donor high-frequency texture survives in the restored area.
function poissonTextureReconstruction(original, mask, bounds, background) {
  const { width: w, height: h, data } = original;
  const donor = new Float32Array(w * h * 3);
  const solution = new Float32Array(w * h * 3);
  const sourceShift = -Math.max(3, Math.min(bounds.y0 - 4, (bounds.y1 - bounds.y0 + 1) + 11));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sy = clamp(y + sourceShift, 1, bounds.y0 - 5);
    const i = (y * w + x) * 4, j = (y * w + x) * 3, k = (sy * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      donor[j + c] = data[k + c];
      solution[j + c] = (mask[y * w + x] || 0) > 0.08 ? background.full[j + c] : data[i + c];
    }
  }
  const laplacian = new Float32Array(w * h * 3);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, i = p * 3;
    for (let c = 0; c < 3; c++) {
      laplacian[i + c] = 4 * donor[i + c]
        - (donor[i - 3 + c] + donor[i + 3 + c] + donor[i - w * 3 + c] + donor[i + w * 3 + c]);
    }
  }
  const members = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    if (mask[p] >= 0.08) members.push(p);
  }
  if (members.length < 20) return null;
  const iterations = Math.max(48, Math.min(115, Math.round(Math.max(w, h) * 1.2)));
  for (let iteration = 0; iteration < iterations; iteration++) {
    let totalStep = 0;
    for (const p of members) {
      const idx = p * 3;
      for (let c = 0; c < 3; c++) {
        const next = (solution[idx - 3 + c] + solution[idx + 3 + c]
          + solution[idx - w * 3 + c] + solution[idx + w * 3 + c] + laplacian[idx + c]) * 0.25;
        const delta = next - solution[idx + c];
        solution[idx + c] += delta * 0.88;
        totalStep += Math.abs(delta);
      }
    }
    if (iteration > 24 && totalStep / (members.length * 3) < 0.018) break;
  }
  return { solution, sourceShift };
}

export function repairVeoWordmarkPaddedRegion(paddedOriginal, inner, alphaMap, gain = 1) {
  const original = cropRegion(paddedOriginal, inner.offsetX, inner.offsetY, inner.width, inner.height);
  const { width: w, height: h, data } = original;
  if (!alphaMap || alphaMap.length !== w * h) throw new Error('Veo wordmark alpha/ROI geometry mismatch');
  const paddedAlpha = embedAlphaMap(alphaMap, w, h, paddedOriginal.width, paddedOriginal.height, inner.offsetX, inner.offsetY);
  const bounds = stencilBounds(alphaMap, w, h);
  let cleaned = original;
  let diagnostics = { accepted: false, correctedPixels: 0, reason: 'no-wordmark-alpha', maskedPixels: 0 };
  if (bounds) {
    const background = robustBackground(original, bounds);
    if (background) {
      const estimated = deriveStrokeMask(original, background, bounds);
      const { mask } = estimated;
      const structure = crossingSceneStructure(original, bounds);
      const highTextureRisk = background.fitMAE >= 36;
      if (mask && !highTextureRisk && !structure.blocked) {
        const reconstruction = poissonTextureReconstruction(original, mask, bounds, background);
        const output = new Uint8ClampedArray(data);
        let corrected = 0, masked = 0, sumBefore = 0, sumAfter = 0;
        if (reconstruction) {
          for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const p = y * w + x, coverage = mask[p];
            if (coverage <= 0.02) continue;
            masked++;
            const i = p * 4;
            let oldError = 0, newError = 0;
            for (let c = 0; c < 3; c++) {
              oldError += Math.abs(data[i + c] - background.full[p * 3 + c]);
              const prediction = clamp(reconstruction.solution[p * 3 + c], 0, 255);
              const delta = clamp(prediction - data[i + c], -175, 175);
              const value = clamp(Math.round(data[i + c] + delta * coverage), 0, 255);
              newError += Math.abs(value - background.full[p * 3 + c]);
              output[i + c] = value;
            }
            sumBefore += oldError / 3; sumAfter += newError / 3;
            if (coverage >= 0.10) corrected++;
          }
        }
        const improvement = sumBefore > 1 ? (sumBefore - sumAfter) / sumBefore : 0;
        const accepted = corrected >= 20 && improvement >= 0.22;
        if (accepted) cleaned = { width: w, height: h, data: output };
        diagnostics = {
          accepted, correctedPixels: accepted ? corrected : 0, maskedPixels: masked,
          reason: accepted ? 'guarded-gradient-domain-wordmark-reconstruction' : 'improvement-gate',
          improvement, backgroundFitMae: background.fitMAE,
          strokeSeeds: estimated.seedCount, strokeBands: estimated.bandCounts,
          sourceShift: reconstruction?.sourceShift || null
        };
        // The first pass must be accepted and its exterior donor smooth enough.
        // A second, strictly local pass may remove correlated bright glyph
        // pinholes. It is independently gated and rolls back on scene risk.
        if (accepted && background.fitMAE < 26) {
          const micro = applyVeoWordmarkResidualMicroFinish(original, cleaned, bounds);
          cleaned = micro.cleaned;
          diagnostics.residualMicroFinish = micro.diagnostics;
        }
      } else {
        diagnostics = {
          accepted: false, correctedPixels: 0, maskedPixels: 0,
          reason: highTextureRisk ? 'high-exterior-structure-risk' : (structure.blocked ? 'crossing-scene-edge' : estimated.reason),
          backgroundFitMae: background.fitMAE, strokeSeeds: estimated.seedCount,
          strokeBands: estimated.bandCounts, structure
        };
      }
    }
  }
  return {
    original, cleaned,
    repairedPadded: pasteRegion(paddedOriginal, cleaned, inner.offsetX, inner.offsetY),
    paddedAlpha,
    atlasSummary: { donorCount: 0, supportedPixels: 0, meanConfidence: 0 },
    temporalDonorAcceptance: { enabled: false, attempted: false, accepted: false, reason: 'wordmark-spatial-only' },
    antiStreakDiagnostics: { riskFlags: diagnostics.accepted ? [] : ['wordmark-repair-' + diagnostics.reason], structured: {} },
    veoWordmark: diagnostics
  };
}

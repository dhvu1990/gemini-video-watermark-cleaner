// A separately gated alpha profile for the small, visible "Veo" text mark.
// Geometry is derived from an operator-provided cropped example; no source
// frame/video is bundled. This profile does not affect Gemini diamond cleanup.
import { inverseAlphaRestore } from './restore.js';
import { sceneEdgeProtectionAt } from './sceneEdgeProtection.js';
import { cropRegion, embedAlphaMap, pasteRegion } from './textureRepair.js';

const REFERENCE_SIZE = 60;
const WORDMARK_X = 14;
const WORDMARK_Y = 35;
const WORDMARK_WIDTH = 31;
const WORDMARK_HEIGHT = 14;
const STENCIL = [
  '0000000000000000000000000000000',
  '0100000001100000000000000000000',
  '0110000011100000000000000000000',
  '0010000011000000000000000000000',
  '0011000010000111000000111100000',
  '0011000110001111110001111110000',
  '0011000110011000110011000111000',
  '0001101100011000010011000011000',
  '0001101100011111110010000011000',
  '0000111100010100000011000011000',
  '0000111000011000010011100111000',
  '0000111000011111110001111110000',
  '0000000000000111000000111100000',
  '0000000000000000000000000000000'
];
const ALPHA_CACHE = new Map();

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function isVeoWordmarkCandidate(candidateId = '') {
  return String(candidateId).startsWith('veo-wordmark-');
}

function stencilAt(x, y) {
  return x >= 0 && x < WORDMARK_WIDTH && y >= 0 && y < WORDMARK_HEIGHT
    ? (STENCIL[y][x] === '1' ? 1 : 0)
    : 0;
}

function sampledStencil(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  return stencilAt(x0, y0) * (1 - fx) * (1 - fy)
    + stencilAt(x0 + 1, y0) * fx * (1 - fy)
    + stencilAt(x0, y0 + 1) * (1 - fx) * fy
    + stencilAt(x0 + 1, y0 + 1) * fx * fy;
}

export function buildVeoWordmarkAlphaMap(size = REFERENCE_SIZE) {
  const n = Math.max(16, Math.round(size));
  if (ALPHA_CACHE.has(n)) return new Float32Array(ALPHA_CACHE.get(n));
  const raw = new Float32Array(n * n);
  const scale = REFERENCE_SIZE / n;
  for (let y = 0; y < n; y++) {
    const sourceY = (y + 0.5) * scale - WORDMARK_Y - 0.5;
    for (let x = 0; x < n; x++) {
      const sourceX = (x + 0.5) * scale - WORDMARK_X - 0.5;
      raw[y * n + x] = sampledStencil(sourceX, sourceY);
    }
  }
  // Small antialias fringe is important for the white translucent letter edges.
  const alpha = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let weighted = raw[y * n + x] * 4, sum = 4;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          const weight = dx && dy ? 1 : 2;
          weighted += raw[yy * n + xx] * weight;
          sum += weight;
        }
      }
      alpha[y * n + x] = clamp(0.76 * weighted / sum, 0, 0.79);
    }
  }
  ALPHA_CACHE.set(n, alpha);
  return new Float32Array(alpha);
}

export function resolveVeoWordmarkCandidates(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 240 || height < 240) return [];
  const scale = clamp(Math.min(width, height) / 720, 0.5, 3);
  const sizes = [...new Set([0.88, 1, 1.12].map((factor) => Math.max(20, Math.round(REFERENCE_SIZE * scale * factor))))];
  const result = [];
  const seen = new Set();
  for (const size of sizes) {
    const factor = size / REFERENCE_SIZE;
    const glyphWidth = WORDMARK_WIDTH * factor;
    const glyphHeight = WORDMARK_HEIGHT * factor;
    const insetX = WORDMARK_X * factor;
    const insetY = WORDMARK_Y * factor;
    for (const side of ['right', 'left']) {
      for (const horizontalMargin of [24, 48, 80]) {
        for (const bottomMargin of [15, 30, 55]) {
          const marginX = horizontalMargin * scale;
          const marginY = bottomMargin * scale;
          const x = Math.round(side === 'right'
            ? width - marginX - glyphWidth - insetX
            : marginX - insetX);
          const y = Math.round(height - marginY - glyphHeight - insetY);
          if (x < 0 || y < 0 || x + size > width || y + size > height) continue;
          const key = [x, y, size].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          result.push({
            id: `veo-wordmark-${side}-${size}-${horizontalMargin}-${bottomMargin}`,
            x, y, size, width: size, height: size,
            priority: side === 'right' ? 0 : 1
          });
        }
      }
    }
  }
  return result;
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function donor(image, alphaMap, x, y, dx, dy, limit) {
  for (let step = 2; step <= limit; step++) {
    const xx = x + step * dx, yy = y + step * dy;
    if (xx < 0 || yy < 0 || xx >= image.width || yy >= image.height) break;
    if ((alphaMap[yy * image.width + xx] || 0) > 0.012) continue;
    return { rgb: pixel(image, xx, yy), distance: step };
  }
  return null;
}

function estimateBackground(image, alphaMap, x, y) {
  const radius = Math.max(6, Math.min(16, Math.round(image.width * 0.22)));
  const pairs = [];
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const backward = donor(image, alphaMap, x, y, -dx, -dy, radius);
    const forward = donor(image, alphaMap, x, y, dx, dy, radius);
    if (!backward || !forward) continue;
    const d = backward.distance + forward.distance;
    const rgb = [0, 1, 2].map((c) => (
      (backward.rgb[c] * forward.distance + forward.rgb[c] * backward.distance) / d
    ));
    const disagreement = [0, 1, 2].reduce(
      (sum, c) => sum + Math.abs(backward.rgb[c] - forward.rgb[c]), 0
    ) / 3;
    pairs.push({ rgb, disagreement });
  }
  if (!pairs.length) return null;
  pairs.sort((a, b) => a.disagreement - b.disagreement);
  if (pairs.length === 1 || pairs[1].disagreement > pairs[0].disagreement + 18) {
    return { rgb: pairs[0].rgb, disagreement: pairs[0].disagreement };
  }
  return {
    rgb: [0, 1, 2].map((c) => (pairs[0].rgb[c] + pairs[1].rgb[c]) / 2),
    disagreement: Math.max(pairs[0].disagreement, pairs[1].disagreement)
  };
}

function rgbError(a, b) {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
}

/**
 * Conservative text-only pass. Unlike the Gemini path it does not run the
 * diamond-specific contour/smooth rebuild chain over a mostly empty square.
 * The same function is used by inspection preview and MP4 export.
 */
export function repairVeoWordmarkPaddedRegion(paddedOriginal, inner, alphaMap, gain = 1) {
  const original = cropRegion(paddedOriginal, inner.offsetX, inner.offsetY, inner.width, inner.height);
  if (!alphaMap || alphaMap.length !== original.width * original.height) {
    throw new Error('Veo wordmark alpha/ROI geometry mismatch');
  }
  const inverse = inverseAlphaRestore(original, alphaMap, clamp(gain, 0.50, 1.35));
  const data = new Uint8ClampedArray(original.data);
  let guardedPixels = 0, correctedPixels = 0, beforeError = 0, afterError = 0;
  const size = original.width;
  for (let y = 2; y < original.height - 2; y++) {
    for (let x = 2; x < original.width - 2; x++) {
      const p = y * size + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < 0.018) continue;
      const background = estimateBackground(original, alphaMap, x, y);
      if (!background) continue;
      const i = p * 4;
      const source = [original.data[i], original.data[i + 1], original.data[i + 2]];
      const candidate = [inverse.data[i], inverse.data[i + 1], inverse.data[i + 2]];
      const before = rgbError(source, background.rgb);
      const after = rgbError(candidate, background.rgb);
      // Roll back a correction that worsens the clean-donor fit.
      if (after > before - 0.8) { guardedPixels++; continue; }
      const edgeRisk = sceneEdgeProtectionAt(original, alphaMap, x, y).weight;
      const uncertainty = clamp((background.disagreement - 25) / 65, 0, 1);
      const blend = clamp((1 - edgeRisk * 0.72) * (1 - uncertainty * 0.72), 0, 1);
      const maxChange = clamp(alpha * 215, 12, 145);
      for (let c = 0; c < 3; c++) {
        const delta = clamp(candidate[c] - source[c], -maxChange, maxChange);
        data[i + c] = clamp(Math.round(source[c] + delta * blend), 0, 255);
      }
      const finalColor = [data[i], data[i + 1], data[i + 2]];
      beforeError += before;
      afterError += rgbError(finalColor, background.rgb);
      correctedPixels++;
      if (blend < 0.8) guardedPixels++;
    }
  }
  const rollback = correctedPixels > 0 && afterError > beforeError * 1.015;
  const cleaned = rollback ? original : { width: original.width, height: original.height, data };
  const paddedAlpha = embedAlphaMap(
    alphaMap, inner.width, inner.height, paddedOriginal.width, paddedOriginal.height,
    inner.offsetX, inner.offsetY
  );
  return {
    original,
    cleaned,
    repairedPadded: pasteRegion(paddedOriginal, cleaned, inner.offsetX, inner.offsetY),
    paddedAlpha,
    atlasSummary: { donorCount: 0, supportedPixels: 0, meanConfidence: 0 },
    temporalDonorAcceptance: { enabled: false, attempted: false, accepted: false, reason: 'wordmark-alpha-only' },
    antiStreakDiagnostics: { riskFlags: rollback ? ['wordmark-repair-rollback'] : [], structured: {} },
    veoWordmark: {
      correctedPixels: rollback ? 0 : correctedPixels,
      guardedPixels, rollback,
      donorErrorBefore: correctedPixels ? beforeError / correctedPixels : 0,
      donorErrorAfter: correctedPixels ? afterError / correctedPixels : 0
    }
  };
}

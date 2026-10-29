// A separately gated detection stencil for the small, visible "Veo" text mark.
// Geometry is derived from an operator-provided cropped example; no source
// frame/video is bundled. This profile does not affect Gemini diamond cleanup.

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
  // Additional compact family based on a real 1920x1080 Veo sample:
  // the visible text is about 35x16 px, 22 px from the right and 23 px
  // from the bottom. Keep the older projected candidates for compatibility.
  // Use the shorter frame dimension so 1080px landscape and portrait video
  // get the same reference text size instead of inflating it by 1080/720.
  const compactScale = clamp(Math.min(width, height) / 1080, 0.5, 1.8);
  const compactSizes = [...new Set([60, 67, 74].map(
    (baseSize) => Math.max(20, Math.round(baseSize * compactScale))
  ))];
  for (const size of compactSizes) {
    const glyphScale = size / REFERENCE_SIZE;
    for (const side of ['right', 'left']) {
      for (const marginX of [18, 22, 30]) {
        for (const marginY of [16, 23, 32]) {
          const horizontal = marginX * compactScale;
          const bottom = marginY * compactScale;
          const x = Math.round(side === 'right'
            ? width - horizontal - (WORDMARK_X + WORDMARK_WIDTH) * glyphScale
            : horizontal - WORDMARK_X * glyphScale);
          const y = Math.round(height - bottom - (WORDMARK_Y + WORDMARK_HEIGHT) * glyphScale);
          if (x < 0 || y < 0 || x + size > width || y + size > height) continue;
          const key = [x, y, size].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          result.push({
            id: `veo-wordmark-${side}-compact-${size}-${marginX}-${marginY}`,
            x, y, size, width: size, height: size,
            priority: side === 'right' ? 0 : 1
          });
        }
      }
    }
  }
  return result;
}

// The text-specific restoration uses actual local scene donors, not inverse alpha.
export { repairVeoWordmarkPaddedRegion } from './veoWordmarkRepair.js';

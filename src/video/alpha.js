import { ALPHA_MAPS } from '../vendor/alphaPayload.js';

const CACHE = new Map();
const ACTIVE_CALIBRATION = new Map();

function base64ToFloat32(base64) {
  if (!base64) return null;
  let bytes;
  if (typeof Buffer !== 'undefined') {
    bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  } else if (typeof atob !== 'undefined') {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    throw new Error('No base64 decoder available');
  }
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function setActiveAlphaCalibration(size, alphaMap, metadata = null) {
  const safeSize = Math.max(16, Math.round(size));
  if (!alphaMap || alphaMap.length !== safeSize * safeSize) return;
  ACTIVE_CALIBRATION.set(safeSize, { alphaMap: new Float32Array(alphaMap), metadata: metadata ? { ...metadata } : null });
}

export function getActiveAlphaCalibration(size) {
  const entry = ACTIVE_CALIBRATION.get(Math.max(16, Math.round(size)));
  return entry ? { alphaMap: new Float32Array(entry.alphaMap), metadata: entry.metadata ? { ...entry.metadata } : null } : null;
}

export function clearActiveAlphaCalibration(size = null) {
  if (Number.isFinite(Number(size))) {
    ACTIVE_CALIBRATION.delete(Math.max(16, Math.round(Number(size))));
    return;
  }
  ACTIVE_CALIBRATION.clear();
}

export function buildProceduralFallbackAlpha(size = 96) {
  const out = new Float32Array(size * size);
  const center = (size - 1) / 2;
  const scale = Math.max(1, center);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = Math.abs((x - center) / scale);
      const ny = Math.abs((y - center) / scale);
      const diamond = nx + ny;
      const axis = Math.min(nx, ny);
      const body = 1 - smoothstep(0.78, 1.03, diamond);
      const pinch = 1 - smoothstep(0.16, 0.64, axis + diamond * 0.08);
      const soft = smoothstep(1.0, 0.2, diamond);
      out[y * size + x] = clamp(body * (0.12 + 0.35 * pinch) * (0.72 + 0.28 * soft), 0, 0.58);
    }
  }
  return out;
}

export function resizeAlphaMapArea(sourceAlpha, sourceSize, targetSize) {
  if (sourceSize === targetSize) return new Float32Array(sourceAlpha);
  const out = new Float32Array(targetSize * targetSize);
  const scale = sourceSize / targetSize;
  for (let y = 0; y < targetSize; y++) {
    const yStart = y * scale;
    const yEnd = (y + 1) * scale;
    const y0 = Math.floor(yStart);
    const y1 = Math.ceil(yEnd);
    for (let x = 0; x < targetSize; x++) {
      const xStart = x * scale;
      const xEnd = (x + 1) * scale;
      const x0 = Math.floor(xStart);
      const x1 = Math.ceil(xEnd);
      let sum = 0;
      let areaSum = 0;
      for (let sy = y0; sy < y1; sy++) {
        if (sy < 0 || sy >= sourceSize) continue;
        const wy = Math.max(0, Math.min(yEnd, sy + 1) - Math.max(yStart, sy));
        for (let sx = x0; sx < x1; sx++) {
          if (sx < 0 || sx >= sourceSize) continue;
          const wx = Math.max(0, Math.min(xEnd, sx + 1) - Math.max(xStart, sx));
          const area = wx * wy;
          sum += sourceAlpha[sy * sourceSize + sx] * area;
          areaSum += area;
        }
      }
      out[y * targetSize + x] = areaSum > 0 ? sum / areaSum : 0;
    }
  }
  return out;
}

export function enhanceAlphaEdges(alphaMap, size, edgeBoost = 0.045) {
  const boost = clamp(Number(edgeBoost) || 0, 0, 0.12);
  if (boost <= 0) return new Float32Array(alphaMap);
  const out = new Float32Array(alphaMap);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const p = y * size + x;
      const a = alphaMap[p] || 0;
      let localMax = a;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          localMax = Math.max(localMax, alphaMap[(y + dy) * size + x + dx] || 0);
        }
      }
      if (localMax < 0.01) continue;
      const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gy = (alphaMap[p + size] || 0) - (alphaMap[p - size] || 0);
      const gradient = Math.hypot(gx, gy);
      const edgeEvidence = clamp((localMax - a) * 5 + gradient * 3, 0, 1);
      const lowAlphaGate = 1 - smoothstep(0.18, 0.55, a);
      out[p] = clamp(a + boost * edgeEvidence * lowAlphaGate, 0, 0.95);
    }
  }
  return out;
}

function embeddedProfile(targetSize, profile) {
  const baseProfile = profile === 'auto'
    ? (targetSize < 40 ? '48' : '96-20260520')
    : String(profile);
  return ALPHA_MAPS[baseProfile] || ALPHA_MAPS['96-20260520'] || ALPHA_MAPS['96'] || ALPHA_MAPS['48'] || null;
}

export async function getVideoAlphaMap(targetSize, profile = 'auto', edgeBoost = 0) {
  const safeSize = Math.max(16, Math.round(targetSize));
  if (profile === 'auto' && Number(edgeBoost || 0) === 0) {
    const active = ACTIVE_CALIBRATION.get(safeSize);
    if (active?.alphaMap) return new Float32Array(active.alphaMap);
  }
  const profileKey = profile === 'auto' ? (safeSize < 40 ? '48' : '96-20260520') : String(profile);
  const safeBoost = clamp(Number(edgeBoost) || 0, 0, 0.12);
  const key = `${profileKey}:${safeSize}:edge${safeBoost.toFixed(3)}`;
  if (CACHE.has(key)) return new Float32Array(CACHE.get(key));

  const encoded = embeddedProfile(safeSize, profile);
  let base = encoded ? base64ToFloat32(encoded) : null;
  let sourceSize = base ? Math.round(Math.sqrt(base.length)) : 0;
  if (!base || sourceSize * sourceSize !== base.length) {
    sourceSize = safeSize >= 40 ? 96 : 48;
    base = buildProceduralFallbackAlpha(sourceSize);
  }

  const resized = resizeAlphaMapArea(base, sourceSize, safeSize);
  const result = safeBoost > 0 ? enhanceAlphaEdges(resized, safeSize, safeBoost) : resized;
  CACHE.set(key, result);
  return new Float32Array(result);
}

export async function getCleanupAlphaMap(targetSize, profile = 'auto', edgeBoost = 0.045) {
  return getVideoAlphaMap(targetSize, profile, edgeBoost);
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeDetectedAlphaMap(alphaMap, width, height) {
  const safeWidth = Math.max(1, Math.round(Number(width) || 0));
  const safeHeight = Math.max(1, Math.round(Number(height) || 0));
  const expected = safeWidth * safeHeight;
  if (!alphaMap || Number(alphaMap.length) !== expected) return null;

  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) {
    const value = Number(alphaMap[i]);
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    out[i] = value;
  }
  return out;
}

export function baseAlphaProfileForSize(size) {
  const safeSize = Math.max(16, Math.round(Number(size) || 0));
  return safeSize < 40 ? '48' : '96-20260520';
}

export function resolveDetectedAlphaGain(configuredGain, detectedGain, defaultGain = 1) {
  const fallback = finite(defaultGain, 1);
  const configured = finite(configuredGain, fallback);
  const detected = finite(detectedGain, null);
  const configuredIsDefault = Math.abs(configured - fallback) <= 1e-9;
  return configuredIsDefault && detected !== null ? detected : configured;
}

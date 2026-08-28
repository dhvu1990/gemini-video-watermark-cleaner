function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePosition(position = null) {
  if (!position) return null;
  const width = Math.round(finite(position.width, finite(position.size, 0)) || 0);
  const height = Math.round(finite(position.height, width) || width);
  const x = Math.round(finite(position.x, Number.NaN));
  const y = Math.round(finite(position.y, Number.NaN));
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function fileCalibrationKey(file = null) {
  if (!file) return '';
  return [
    String(file.name || ''),
    String(finite(file.size, 0) || 0),
    String(finite(file.lastModified, 0) || 0),
    String(file.type || '')
  ].join('::');
}

export function calibrationMatchesRegion(calibration = null, region = null) {
  const stored = normalizePosition(calibration?.position);
  const requested = normalizePosition(region);
  if (!stored || !requested) return false;
  return stored.x === requested.x
    && stored.y === requested.y
    && stored.width === requested.width
    && stored.height === requested.height;
}

function cloneCalibration(entry = null) {
  if (!entry?.alphaMap || !entry.position) return null;
  return {
    alphaMap: new Float32Array(entry.alphaMap),
    alphaGain: finite(entry.alphaGain, null),
    position: { ...entry.position },
    candidateId: entry.candidateId || null
  };
}

export function createDetectionCalibrationCache(maxEntries = 32) {
  const cache = new Map();
  const limit = Math.max(1, Math.min(128, Math.round(finite(maxEntries, 32) || 32)));

  function remember(file, detection = null) {
    const key = fileCalibrationKey(file);
    const position = normalizePosition(detection?.position);
    const alphaMap = detection?.alphaMap;
    if (!key || !position || !alphaMap || alphaMap.length !== position.width * position.height) return null;
    const entry = {
      alphaMap: new Float32Array(alphaMap),
      alphaGain: finite(detection?.alphaGain, null),
      position,
      candidateId: detection?.candidateId || null
    };
    if (cache.has(key)) cache.delete(key);
    cache.set(key, entry);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    return cloneCalibration(entry);
  }

  function get(file, region = null) {
    const entry = cache.get(fileCalibrationKey(file));
    if (!entry) return null;
    if (region && !calibrationMatchesRegion(entry, region)) return null;
    return cloneCalibration(entry);
  }

  return {
    remember,
    get,
    clear() { cache.clear(); },
    get size() { return cache.size; }
  };
}

export function selectExportAlphaGain(configuredGain, calibratedGain, defaultGain = 1) {
  const fallback = finite(defaultGain, 1) || 1;
  const configured = finite(configuredGain, fallback);
  const calibrated = finite(calibratedGain, null);
  if (!Number.isFinite(calibrated) || calibrated <= 0) return configured;
  if (Math.abs(configured - fallback) <= 1e-6) return calibrated;
  return configured;
}

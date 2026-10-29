// Localized, reversible second pass for already-accepted visible Veo text repair.
// Called only from Veo wordmark repair, never Gemini detection/restoration.
const clamp = (a, lo, hi) => Math.max(lo, Math.min(hi, a));
const luma = (data, i) => data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
const GAUSS = [1, 4, 6, 4, 1];

function positiveDetail(image) {
  const { width: w, height: h, data } = image;
  const n = w * h, result = new Float32Array(n), luminance = new Float32Array(n);
  for (let p = 0; p < n; p++) luminance[p] = luma(data, p * 4);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    let smooth = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      smooth += GAUSS[dy + 2] * GAUSS[dx + 2] * luminance[(y + dy) * w + x + dx];
    }
    const p = y * w + x;
    result[p] = Math.max(0, luminance[p] - smooth / 256);
  }
  return result;
}

function buildEvidence(original, cleaned, bounds) {
  const { width: w, height: h } = original, n = w * h;
  const seeds = new Uint8Array(n), mask = new Uint8Array(n), exclusion = new Uint8Array(n);
  const x0 = clamp(bounds.x0 - 2, 3, w - 4), x1 = clamp(bounds.x1 + 2, 3, w - 4);
  const y0 = clamp(bounds.y0 - 2, 3, h - 4), y1 = clamp(bounds.y1 + 2, 3, h - 4);
  const bands = [0, 0, 0];
  let seedCount = 0;

  // White overlay evidence is positive in all RGB channels. This excludes
  // most orange reflections and non-white high-frequency scene features.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = y * w + x, i = p * 4;
    const dr = original.data[i] - cleaned.data[i];
    const dg = original.data[i + 1] - cleaned.data[i + 1];
    const db = original.data[i + 2] - cleaned.data[i + 2];
    const bright = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
    if (bright <= 24 || Math.min(dr, dg, db) <= 13) continue;
    seeds[p] = 1;
    seedCount++;
    bands[clamp(Math.floor((x - x0) / Math.max(1, x1 - x0 + 1) * 3), 0, 2)]++;
  }
  if (seedCount < Math.max(40, Math.round(w * 0.7)) || bands.some(n => n < 7)) {
    return { reason: 'no-three-letter-residual-evidence', seedCount, bands };
  }

  // Bounded 3px repair halo (a 5px exclusion ring is for diagnostics only).
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!seeds[y * w + x]) continue;
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 2 || yy < 2 || xx >= w - 2 || yy >= h - 2) continue;
      const p = yy * w + xx;
      exclusion[p] = 1;
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) mask[p] = 1;
    }
  }
  let masked = 0;
  for (const item of mask) if (item) masked++;
  if (masked < n * 0.07 || masked > n * 0.31) {
    return { reason: 'unsafe-residual-footprint', seedCount, bands, masked };
  }
  return { seeds, mask, exclusion, bounds: { x0, x1, y0, y1 }, masked, seedCount, bands };
}

function measure(detail, width, evidence) {
  const { seeds, exclusion, bounds } = evidence;
  let a = 0, ac = 0, b = 0, bc = 0;
  for (let y = bounds.y0; y <= bounds.y1; y++) for (let x = bounds.x0; x <= bounds.x1; x++) {
    const p = y * width + x;
    if (seeds[p]) { a += detail[p]; ac++; }
    else if (!exclusion[p]) { b += detail[p]; bc++; }
  }
  return { aligned: ac ? a / ac : 0, exterior: bc ? b / bc : 0, exteriorSamples: bc };
}

function poissonFromClean(image, mask, bounds) {
  const { width: w, height: h, data } = image, n = w * h;
  if (bounds.y0 < 12) return null;
  const donor = new Float32Array(n * 3);
  const solution = new Float32Array(n * 3);
  const laplacian = new Float32Array(n * 3);
  const shift = -Math.max(3, Math.min(bounds.y0 - 4, bounds.y1 - bounds.y0 + 12));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sy = clamp(y + shift, 1, bounds.y0 - 5), p = y * w + x;
    const i = p * 4, j = p * 3, k = (sy * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      donor[j + c] = data[k + c];
      solution[j + c] = data[i + c];
    }
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const j = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) {
      laplacian[j + c] = 4 * donor[j + c] - (
        donor[j - 3 + c] + donor[j + 3 + c] +
        donor[j - w * 3 + c] + donor[j + w * 3 + c]
      );
    }
  }
  const members = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    if (mask[y * w + x]) members.push(y * w + x);
  }
  if (members.length < 30) return null;
  for (let iteration = 0; iteration < 132; iteration++) {
    for (const p of members) {
      const j = p * 3;
      for (let c = 0; c < 3; c++) {
        const next = (
          solution[j - 3 + c] + solution[j + 3 + c] +
          solution[j - w * 3 + c] + solution[j + w * 3 + c] +
          laplacian[j + c]
        ) * 0.25;
        solution[j + c] += 0.90 * (next - solution[j + c]);
      }
    }
  }
  return { solution, members };
}

/**
 * No force switch. Caller must already have passed wordmark detection, stroke
 * consensus, donor quality and crossing-scene-edge safety gates.
 * The output is byte-identical when evidence/quality gates reject.
 */
export function applyVeoWordmarkResidualMicroFinish(original, cleaned, bounds) {
  const unchanged = (reason, extra = {}) => ({
    cleaned, diagnostics: { applied: false, reason, changedPixels: 0, ...extra }
  });
  if (!original?.data || !cleaned?.data || !bounds ||
    original.width !== cleaned.width || original.height !== cleaned.height) {
    return unchanged('invalid-wordmark-context');
  }
  const evidence = buildEvidence(original, cleaned, bounds);
  if (!evidence.seeds) return unchanged(evidence.reason, {
    seedCount: evidence.seedCount, bands: evidence.bands
  });
  const initial = measure(positiveDetail(cleaned), cleaned.width, evidence);
  if (initial.exteriorSamples < 12) return unchanged('missing-exterior-baseline');
  const excess = initial.aligned - initial.exterior;
  if (excess < 0.55 || initial.aligned < 1 ||
      initial.aligned < initial.exterior * 1.65) {
    return unchanged('no-correlated-bright-ghost', { initial, seedCount: evidence.seedCount });
  }
  const donor = poissonFromClean(cleaned, evidence.mask, evidence.bounds);
  if (!donor) return unchanged('no-safe-texture-donor');

  const strength = clamp((excess - 0.25) / 1.35, 0, 0.96);
  const output = new Uint8ClampedArray(cleaned.data);
  let sumDiff = 0, sumLumaDiff = 0, maxDelta = 0;
  for (const p of donor.members) {
    const i = p * 4, j = p * 3, before = luma(output, i);
    for (let c = 0; c < 3; c++) {
      const prev = cleaned.data[i + c];
      const delta = clamp(donor.solution[j + c] - prev, -42, 42);
      const value = clamp(Math.round(prev + delta * strength), 0, 255);
      output[i + c] = value;
      const change = Math.abs(value - prev);
      sumDiff += change;
      maxDelta = Math.max(maxDelta, change);
    }
    sumLumaDiff += Math.abs(luma(output, i) - before);
  }
  const candidate = { width: cleaned.width, height: cleaned.height, data: output };
  const after = measure(positiveDetail(candidate), cleaned.width, evidence);
  const alignedImprovement = initial.aligned - after.aligned;
  const count = donor.members.length;
  const avgChannelChange = sumDiff / (count * 3), avgLumaChange = sumLumaDiff / count;
  const accepted = alignedImprovement >= Math.max(0.22, initial.aligned * 0.13) &&
    avgChannelChange <= 15 && avgLumaChange <= 14 && maxDelta <= 41;

  return {
    cleaned: accepted ? candidate : cleaned,
    diagnostics: {
      applied: accepted,
      reason: accepted ? 'aligned-micro-ghost-suppression' : 'residual-safety-rollback',
      alignedImprovement, initial, after, strength,
      maskedPixels: evidence.masked, seedCount: evidence.seedCount,
      changedPixels: accepted ? count : 0,
      avgChannelChange, avgLumaChange, maxDelta
    }
  };
}

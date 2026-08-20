import { buildHybridRepairMask } from './textureRepair.js';
import { applyLocalToneMatch } from './localToneMatch.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

function bilinearScalar(values, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const v00 = values[y0 * width + x0] || 0;
  const v10 = values[y0 * width + x1] || 0;
  const v01 = values[y1 * width + x0] || 0;
  const v11 = values[y1 * width + x1] || 0;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

function bilinearRgb(image, x, y) {
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const at = (xx, yy, c) => image.data[(yy * image.width + xx) * 4 + c];
  return [0, 1, 2].map((c) => (
    at(x0, y0, c) * (1 - fx) * (1 - fy)
    + at(x1, y0, c) * fx * (1 - fy)
    + at(x0, y1, c) * (1 - fx) * fy
    + at(x1, y1, c) * fx * fy
  ));
}

function alphaGradient(alphaMap, width, x, y) {
  const p = y * width + x;
  const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
  const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function imageGradient(image, x, y) {
  const left = bilinearRgb(image, x - 1, y);
  const right = bilinearRgb(image, x + 1, y);
  const up = bilinearRgb(image, x, y - 1);
  const down = bilinearRgb(image, x, y + 1);
  if (!left || !right || !up || !down) return { gx: 0, gy: 0, magnitude: 0 };
  const gx = (luma(right) - luma(left)) * 0.5;
  const gy = (luma(down) - luma(up)) * 0.5;
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function findAnchor(image, alphaMap, x, y, nx, ny, sign, mode, maxRadius = 7.5) {
  for (let distance = 0.75; distance <= maxRadius; distance += 0.75) {
    const sx = x + nx * distance * sign;
    const sy = y + ny * distance * sign;
    const alpha = bilinearScalar(alphaMap, image.width, image.height, sx, sy);
    if (alpha === null) break;
    const valid = mode === 'outer' ? alpha <= 0.008 : alpha >= 0.12;
    if (!valid) continue;
    const rgb = bilinearRgb(image, sx, sy);
    if (rgb) return { rgb, distance };
  }
  return null;
}

function bridgeTarget(outer, inner) {
  const span = outer.distance + inner.distance;
  if (span <= 0) return null;
  const outerWeight = inner.distance / span;
  const innerWeight = outer.distance / span;
  return [0, 1, 2].map((c) => outer.rgb[c] * outerWeight + inner.rgb[c] * innerWeight);
}

function sampleShapeResidual(image, alphaMap, masks, x, y, options = {}) {
  if (x < 2 || y < 2 || x >= image.width - 2 || y >= image.height - 2) return null;
  const p = y * image.width + x;
  const alpha = alphaMap[p] || 0;
  const edge = masks.edge[p] || 0;
  const feather = masks.feather[p] || 0;
  const core = masks.core[p] || 0;
  const ring = clamp(edge * 1.18 + feather * 0.30 - core * 1.08, 0, 1);
  if (alpha < (options.minAlpha ?? 0.006) || ring < (options.minRing ?? 0.17) || core > (options.maxCore ?? 0.52)) return null;

  const ag = alphaGradient(alphaMap, image.width, x, y);
  if (ag.magnitude < 0.0014) return null;
  const ig = imageGradient(image, x, y);
  if (ig.magnitude < 0.75) return null;
  const alignment = Math.abs((ig.gx * ag.gx + ig.gy * ag.gy) / Math.max(1e-6, ig.magnitude * ag.magnitude));
  const minAlignment = Number(options.minAlignment ?? 0.58);
  if (alignment < minAlignment) return null;

  const nx = ag.gx / ag.magnitude;
  const ny = ag.gy / ag.magnitude;
  const tx = -ny, ty = nx;
  const outer = findAnchor(image, alphaMap, x, y, nx, ny, -1, 'outer', options.anchorRadius ?? 7.5);
  const inner = findAnchor(image, alphaMap, x, y, nx, ny, 1, 'inner', options.anchorRadius ?? 7.5);
  if (!outer || !inner) return null;
  const target = bridgeTarget(outer, inner);
  if (!target) return null;

  const current = bilinearRgb(image, x, y);
  const tangentA = bilinearRgb(image, x + tx * 1.5, y + ty * 1.5);
  const tangentB = bilinearRgb(image, x - tx * 1.5, y - ty * 1.5);
  if (!current || !tangentA || !tangentB) return null;
  const residual = luma(current) - luma(target);
  const anchorDelta = (Math.abs(outer.rgb[0] - inner.rgb[0]) + Math.abs(outer.rgb[1] - inner.rgb[1]) + Math.abs(outer.rgb[2] - inner.rgb[2])) / 3;
  const tangentDelta = Math.abs(luma(tangentA) - luma(tangentB));
  return { p, idx: p * 4, ring, alignment, tx, ty, target, residual, anchorDelta, tangentDelta };
}

function sameResidualSign(a, b, minMagnitude) {
  return Math.abs(a) >= minMagnitude && Math.abs(b) >= minMagnitude && a * b > 0;
}

export function applyCoherentStructuredShapePass(image, alphaMap, options = {}) {
  if (!alphaMap || alphaMap.length !== image.width * image.height || options.enabled === false) {
    return { image: { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }, correctedPixels: 0, coherentCandidates: 0, guardedPixels: 0, meanBlend: 0, meanAbsLumaDelta: 0 };
  }

  const masks = buildHybridRepairMask(alphaMap, image.width, image.height);
  const out = new Uint8ClampedArray(image.data);
  const strength = clamp(Number(options.strength ?? 0.24), 0.06, 0.34);
  const minNeighborResidual = Number(options.minNeighborResidual ?? 0.72);
  const maxLumaDelta = Math.max(2, Number(options.maxLumaDelta ?? 8.5));
  let correctedPixels = 0, coherentCandidates = 0, guardedPixels = 0, blendSum = 0, deltaSum = 0;

  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const sample = sampleShapeResidual(image, alphaMap, masks, x, y, options);
      if (!sample || Math.abs(sample.residual) < (options.minResidual ?? 1.05)) continue;
      const tangentDistance = Number(options.tangentDistance ?? 2.0);
      const ax = Math.round(x + sample.tx * tangentDistance);
      const ay = Math.round(y + sample.ty * tangentDistance);
      const bx = Math.round(x - sample.tx * tangentDistance);
      const by = Math.round(y - sample.ty * tangentDistance);
      const neighborA = sampleShapeResidual(image, alphaMap, masks, ax, ay, options);
      const neighborB = sampleShapeResidual(image, alphaMap, masks, bx, by, options);
      if (!neighborA || !neighborB) continue;
      if (!sameResidualSign(sample.residual, neighborA.residual, minNeighborResidual)
        || !sameResidualSign(sample.residual, neighborB.residual, minNeighborResidual)) continue;
      coherentCandidates++;

      const structureGuard = Math.max(
        smoothstep(options.anchorGuardLow ?? 34, options.anchorGuardHigh ?? 94, sample.anchorDelta),
        smoothstep(options.tangentGuardLow ?? 28, options.tangentGuardHigh ?? 76, sample.tangentDelta)
      );
      if (structureGuard >= 0.985) { guardedPixels++; continue; }
      const alignmentWeight = smoothstep(options.minAlignment ?? 0.58, 0.96, sample.alignment);
      const residualGate = smoothstep(options.minResidual ?? 1.05, options.fullResidual ?? 6.5, Math.abs(sample.residual));
      const neighborFloor = Math.min(Math.abs(neighborA.residual), Math.abs(neighborB.residual), Math.abs(sample.residual));
      const neighborCeil = Math.max(Math.abs(neighborA.residual), Math.abs(neighborB.residual), Math.abs(sample.residual), 1e-6);
      const coherenceWeight = smoothstep(0.18, 0.72, neighborFloor / neighborCeil);
      const blend = Math.min(0.25, strength * sample.ring * alignmentWeight * residualGate * coherenceWeight * (1 - structureGuard * 0.94));
      if (blend < 0.022) continue;

      const targetY = luma(sample.target);
      const currentY = luma([image.data[sample.idx], image.data[sample.idx + 1], image.data[sample.idx + 2]]);
      const shift = clamp(targetY - currentY, -maxLumaDelta, maxLumaDelta) * blend;
      if (Math.abs(shift) < 0.10) continue;
      for (let c = 0; c < 3; c++) out[sample.idx + c] = clampByte(image.data[sample.idx + c] + shift);
      correctedPixels++;
      blendSum += blend;
      deltaSum += Math.abs(shift);
    }
  }

  return { image: { width: image.width, height: image.height, data: out }, correctedPixels, coherentCandidates, guardedPixels, meanBlend: correctedPixels ? blendSum / correctedPixels : 0, meanAbsLumaDelta: correctedPixels ? deltaSum / correctedPixels : 0 };
}

export function buildStructuredEvidenceCandidate(image, alphaMap, options = {}) {
  const shape = applyCoherentStructuredShapePass(image, alphaMap, {
    enabled: options.shapeCoherent !== false,
    strength: options.refinementStrength ?? 0.24,
    minAlignment: options.refinementMinAlignment ?? 0.58,
    maxLumaDelta: options.refinementMaxLumaDelta ?? 8.5,
    minResidual: options.refinementMinResidual ?? 1.05,
    fullResidual: options.refinementFullResidual ?? 6.5,
    minNeighborResidual: options.refinementMinNeighborResidual ?? 0.72
  });
  let selected = shape.correctedPixels > 0 ? shape.image : image;

  const persistenceEnabled = options.refinementPersistence !== false;
  const persistence = persistenceEnabled && shape.correctedPixels > 0
    ? applyCoherentStructuredShapePass(selected, alphaMap, {
        enabled: true,
        strength: options.refinementPersistenceStrength ?? 0.16,
        minAlignment: options.refinementPersistenceMinAlignment ?? 0.60,
        maxLumaDelta: options.refinementPersistenceMaxLumaDelta ?? 5.5,
        minResidual: options.refinementPersistenceMinResidual ?? 0.78,
        fullResidual: options.refinementPersistenceFullResidual ?? 4.8,
        minNeighborResidual: options.refinementPersistenceMinNeighborResidual ?? 0.58,
        tangentDistance: options.refinementPersistenceTangentDistance ?? 1.5
      })
    : { image: selected, correctedPixels: 0, coherentCandidates: 0, guardedPixels: 0, meanBlend: 0, meanAbsLumaDelta: 0 };
  if (persistence.correctedPixels > 0) selected = persistence.image;

  const toneMicroEnabled = options.refinementToneMicro !== false;
  const toneResult = toneMicroEnabled
    ? applyLocalToneMatch(selected, alphaMap, {
        enabled: true,
        strength: options.refinementToneStrength ?? 0.40,
        maxLumaShift: options.refinementToneMaxShift ?? 5.5,
        maxLocalShift: options.refinementToneMaxLocalShift ?? 4.5,
        localMix: options.refinementToneLocalMix ?? 0.34,
        sectorMix: options.refinementToneSectorMix ?? 0.56,
        minScore: options.refinementToneMinScore ?? 0.72,
        minImprovement: options.refinementToneMinImprovement ?? 0.025,
        minSamples: options.refinementToneMinSamples ?? 12,
        minReferenceSamples: options.refinementToneMinReferenceSamples ?? 20,
        gradientMax: options.refinementToneGradientMax ?? 9.5,
        referenceGradientMax: options.refinementToneReferenceGradientMax ?? 10.5
      })
    : { width: selected.width, height: selected.height, data: new Uint8ClampedArray(selected.data), localToneMatch: { enabled: false, attempted: false, accepted: false } };
  const toneMicro = toneResult.localToneMatch || { enabled: toneMicroEnabled, attempted: false, accepted: false };
  if (toneMicro.accepted) selected = { width: toneResult.width, height: toneResult.height, data: toneResult.data };

  const shapePixels = shape.correctedPixels + persistence.correctedPixels;
  const baseMode = shapePixels > 0
    ? (persistence.correctedPixels > 0 ? 'shape-coherent+persistence' : 'shape-coherent')
    : 'none';
  return {
    image: selected,
    shape,
    persistence: {
      enabled: persistenceEnabled,
      attempted: persistenceEnabled && shape.correctedPixels > 0,
      accepted: persistence.correctedPixels > 0,
      correctedPixels: persistence.correctedPixels,
      coherentCandidates: persistence.coherentCandidates,
      guardedPixels: persistence.guardedPixels,
      meanBlend: persistence.meanBlend,
      meanAbsLumaDelta: persistence.meanAbsLumaDelta
    },
    toneMicro,
    candidatePixels: shapePixels + (toneMicro.accepted ? (toneMicro.correctedPixels || 0) : 0),
    mode: baseMode !== 'none'
      ? (toneMicro.accepted ? `${baseMode}+tone-micro` : baseMode)
      : (toneMicro.accepted ? 'tone-micro' : 'none')
  };
}

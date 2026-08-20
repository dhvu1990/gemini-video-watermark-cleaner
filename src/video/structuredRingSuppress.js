import { buildHybridRepairMask } from './textureRepair.js';
import { measurePostCleanupResidual } from './edgeBridge.js';
import { applyStructuredConsensusRepair } from './structuredConsensusRepair.js';
import { applyShapeGhostSuppression } from './shapeGhostSuppress.js';
import { applyCenterSeamSuppression } from './centerSeamSuppress.js';
import { applyLocalToneMatch } from './localToneMatch.js';
import { applyOuterHaloSuppression } from './outerHaloSuppress.js';
import { buildStructuredEvidenceCandidate } from './structuredEvidenceRefine.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function rgbToYcbcr(rgb) {
  const y = luma(rgb);
  return [y, (rgb[2] - y) * 0.5389, (rgb[0] - y) * 0.6350];
}
function ycbcrToRgb(y, cb, cr) {
  const r = y + cr / 0.6350;
  const b = y + cb / 0.5389;
  const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return [clampByte(r), clampByte(g), clampByte(b)];
}

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
  const sample = (xx, yy, c) => image.data[(yy * image.width + xx) * 4 + c];
  return [0, 1, 2].map((c) => (
    sample(x0, y0, c) * (1 - fx) * (1 - fy)
    + sample(x1, y0, c) * fx * (1 - fy)
    + sample(x0, y1, c) * (1 - fx) * fy
    + sample(x1, y1, c) * fx * fy
  ));
}

function alphaGradient(alphaMap, width, x, y) {
  const p = y * width + x;
  const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
  const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
  return { gx, gy, magnitude: Math.hypot(gx, gy) };
}

function imageGradient(image, x, y) {
  const { width, data } = image;
  const left = luma([data[(y * width + x - 1) * 4], data[(y * width + x - 1) * 4 + 1], data[(y * width + x - 1) * 4 + 2]]);
  const right = luma([data[(y * width + x + 1) * 4], data[(y * width + x + 1) * 4 + 1], data[(y * width + x + 1) * 4 + 2]]);
  const up = luma([data[((y - 1) * width + x) * 4], data[((y - 1) * width + x) * 4 + 1], data[((y - 1) * width + x) * 4 + 2]]);
  const down = luma([data[((y + 1) * width + x) * 4], data[((y + 1) * width + x) * 4 + 1], data[((y + 1) * width + x) * 4 + 2]]);
  const gx = (right - left) * 0.5;
  const gy = (down - up) * 0.5;
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
    if (rgb) return { rgb, distance, alpha };
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

function localAlignment(image, alphaMap, x, y) {
  const ag = alphaGradient(alphaMap, image.width, x, y);
  if (ag.magnitude < 0.0014) return null;
  const ig = imageGradient(image, x, y);
  if (ig.magnitude < 0.8) return { ag, ig, alignment: 0 };
  const alignment = Math.abs((ig.gx * ag.gx + ig.gy * ag.gy) / Math.max(1e-6, ig.magnitude * ag.magnitude));
  return { ag, ig, alignment };
}

export function measureStructuredRingResidual(image, alphaMap) {
  const masks = buildHybridRepairMask(alphaMap, image.width, image.height);
  let scoreSum = 0, weightSum = 0, samples = 0;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ring = clamp(edge * 1.10 + feather * 0.22 - core * 1.02, 0, 1);
      if (alpha < 0.006 || ring < 0.18 || core > 0.48) continue;
      const aligned = localAlignment(image, alphaMap, x, y);
      if (!aligned || aligned.alignment < 0.42) continue;
      const nx = aligned.ag.gx / aligned.ag.magnitude;
      const ny = aligned.ag.gy / aligned.ag.magnitude;
      const outer = findAnchor(image, alphaMap, x, y, nx, ny, -1, 'outer');
      const inner = findAnchor(image, alphaMap, x, y, nx, ny, 1, 'inner');
      if (!outer || !inner) continue;
      const target = bridgeTarget(outer, inner);
      if (!target) continue;
      const idx = p * 4;
      const current = rgbToYcbcr([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
      const wanted = rgbToYcbcr(target);
      const lumaResidual = Math.abs(current[0] - wanted[0]);
      const chromaResidual = (Math.abs(current[1] - wanted[1]) + Math.abs(current[2] - wanted[2])) * 0.5;
      const alignmentWeight = smoothstep(0.42, 0.92, aligned.alignment);
      const weight = ring * alignmentWeight * (0.65 + Math.min(0.35, aligned.ag.magnitude * 5));
      scoreSum += (lumaResidual * 0.78 + chromaResidual * 0.22) * weight;
      weightSum += weight;
      samples++;
    }
  }
  return { score: weightSum ? scoreSum / weightSum : 0, samples };
}

function applyStructuredRingPass(image, alphaMap, strength = 0.50) {
  const safeStrength = clamp(Number(strength) || 0, 0, 0.72);
  const masks = buildHybridRepairMask(alphaMap, image.width, image.height);
  const out = new Uint8ClampedArray(image.data);
  let correctedPixels = 0, blendSum = 0, deltaSum = 0;
  for (let y = 2; y < image.height - 2; y++) {
    for (let x = 2; x < image.width - 2; x++) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      const edge = masks.edge[p] || 0;
      const feather = masks.feather[p] || 0;
      const core = masks.core[p] || 0;
      const ring = clamp(edge * 1.16 + feather * 0.24 - core * 1.12, 0, 1);
      if (alpha < 0.006 || ring < 0.22 || core > 0.44) continue;
      const aligned = localAlignment(image, alphaMap, x, y);
      if (!aligned || aligned.alignment < 0.50) continue;
      const nx = aligned.ag.gx / aligned.ag.magnitude;
      const ny = aligned.ag.gy / aligned.ag.magnitude;
      const tx = -ny, ty = nx;
      const outer = findAnchor(image, alphaMap, x, y, nx, ny, -1, 'outer', 6.5);
      const inner = findAnchor(image, alphaMap, x, y, nx, ny, 1, 'inner', 6.5);
      if (!outer || !inner) continue;
      const target = bridgeTarget(outer, inner);
      if (!target) continue;
      const tangentA = bilinearRgb(image, x + tx * 1.5, y + ty * 1.5);
      const tangentB = bilinearRgb(image, x - tx * 1.5, y - ty * 1.5);
      const tangentDelta = tangentA && tangentB ? Math.abs(luma(tangentA) - luma(tangentB)) : 0;
      const anchorDelta = (Math.abs(outer.rgb[0] - inner.rgb[0]) + Math.abs(outer.rgb[1] - inner.rgb[1]) + Math.abs(outer.rgb[2] - inner.rgb[2])) / 3;
      const structureGuard = Math.max(smoothstep(28, 86, anchorDelta), smoothstep(22, 62, tangentDelta));
      const alignmentWeight = smoothstep(0.50, 0.94, aligned.alignment);
      const idx = p * 4;
      const current = rgbToYcbcr([image.data[idx], image.data[idx + 1], image.data[idx + 2]]);
      const wanted = rgbToYcbcr(target);
      const lumaResidual = Math.abs(current[0] - wanted[0]);
      const residualGate = smoothstep(1.0, 8.5, lumaResidual);
      const blend = Math.min(0.44, safeStrength * ring * alignmentWeight * residualGate * (1 - structureGuard * 0.90));
      if (blend < 0.035) continue;
      const yValue = current[0] + clamp(wanted[0] - current[0], -16, 16) * blend;
      const chromaBlend = Math.min(0.18, blend * 0.34);
      const cbValue = current[1] + clamp(wanted[1] - current[1], -12, 12) * chromaBlend;
      const crValue = current[2] + clamp(wanted[2] - current[2], -12, 12) * chromaBlend;
      const rgb = ycbcrToRgb(yValue, cbValue, crValue);
      out[idx] = rgb[0]; out[idx + 1] = rgb[1]; out[idx + 2] = rgb[2];
      correctedPixels++; blendSum += blend; deltaSum += Math.abs(yValue - current[0]);
    }
  }
  return { image: { width: image.width, height: image.height, data: out }, correctedPixels, meanBlend: correctedPixels ? blendSum / correctedPixels : 0, meanAbsLumaDelta: correctedPixels ? deltaSum / correctedPixels : 0 };
}

function applyEvidenceGatedRefinement(image, alphaMap, options = {}) {
  const enabled = options.evidenceRefinement !== false;
  const minScore = Number.isFinite(options.refinementMinScore) ? options.refinementMinScore : 1.75;
  const minDensity = Number.isFinite(options.refinementMinDensity) ? options.refinementMinDensity : 0.012;
  const strength = clamp(Number(options.refinementStrength ?? 0.22), 0.08, 0.30);
  const beforeAligned = measureStructuredRingResidual(image, alphaMap);
  const density = alphaMap.length ? beforeAligned.samples / alphaMap.length : 0;
  const attempted = enabled && beforeAligned.score >= minScore && density >= minDensity;
  const state = {
    enabled,
    attempted,
    accepted: false,
    minScore,
    minDensity,
    strength,
    density,
    beforeAligned,
    candidateAlignedAfter: beforeAligned,
    beforeGlobal: null,
    candidateGlobalAfter: null,
    correctedPixels: 0,
    candidatePixels: 0,
    candidateMode: 'none',
    coherentCandidates: 0,
    guardedPixels: 0,
    meanBlend: 0,
    meanAbsLumaDelta: 0,
    shapeCoherent: null,
    toneMicro: { enabled: options.refinementToneMicro !== false, attempted: false, accepted: false }
  };
  if (!attempted) return { image, state };

  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const candidate = buildStructuredEvidenceCandidate(image, alphaMap, { ...options, refinementStrength: strength });
  const candidateAlignedAfter = measureStructuredRingResidual(candidate.image, alphaMap);
  const candidateGlobalAfter = measurePostCleanupResidual(candidate.image, alphaMap);
  const alignedImprovement = beforeAligned.score > 1e-6
    ? (beforeAligned.score - candidateAlignedAfter.score) / beforeAligned.score
    : 0;
  const accepted = candidate.candidatePixels > 0
    && alignedImprovement >= 0.015
    && candidateAlignedAfter.score <= beforeAligned.score * 0.985
    && candidateGlobalAfter.total <= beforeGlobal.total * 1.002
    && candidateGlobalAfter.luma <= beforeGlobal.luma * 1.004
    && candidateGlobalAfter.chroma <= beforeGlobal.chroma * 1.004;
  Object.assign(state, {
    accepted,
    beforeGlobal,
    candidateGlobalAfter,
    candidateAlignedAfter,
    candidateAlignedImprovement: alignedImprovement,
    alignedImprovement: accepted ? alignedImprovement : 0,
    correctedPixels: accepted ? candidate.candidatePixels : 0,
    candidatePixels: candidate.candidatePixels,
    candidateMode: candidate.mode,
    coherentCandidates: candidate.shape?.coherentCandidates || 0,
    guardedPixels: candidate.shape?.guardedPixels || 0,
    meanBlend: accepted ? (candidate.shape?.meanBlend || 0) : 0,
    meanAbsLumaDelta: accepted ? (candidate.shape?.meanAbsLumaDelta || 0) : 0,
    shapeCoherent: candidate.shape || null,
    toneMicro: candidate.toneMicro || state.toneMicro
  });
  return { image: accepted ? candidate.image : image, state };
}

function finishWithShapeGhost(image, alphaMap, options) {
  if (options.shapeGhost === false) {
    return { width: image.width, height: image.height, data: image.data, shapeGhost: { enabled: false, attempted: false, accepted: false } };
  }
  return applyShapeGhostSuppression(image, alphaMap, { enabled: true, ...(options.shapeGhostOptions || {}) });
}

function finishWithCenterSeam(image, alphaMap, options) {
  if (options.centerSeam === false) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), centerSeam: { enabled: false, attempted: false, accepted: false } };
  }
  return applyCenterSeamSuppression(image, alphaMap, { enabled: true, ...(options.centerSeamOptions || {}) });
}

function finishWithLocalTone(image, alphaMap, options) {
  if (options.localToneMatch === false) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), localToneMatch: { enabled: false, attempted: false, accepted: false } };
  }
  return applyLocalToneMatch(image, alphaMap, { enabled: true, ...(options.localToneOptions || {}) });
}

function finishWithOuterHalo(image, alphaMap, options) {
  if (options.outerHalo === false) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), outerHalo: { enabled: false, attempted: false, accepted: false } };
  }
  return applyOuterHaloSuppression(image, alphaMap, { enabled: true, ...(options.outerHaloOptions || {}) });
}

function appendMode(baseMode, suffix, accepted) {
  if (!accepted) return baseMode;
  return baseMode && baseMode !== 'none' ? `${baseMode}+${suffix}` : suffix;
}

export function applyStructuredResidualRingSuppression(image, alphaMap, options = {}) {
  if (options.enabled === false || alphaMap.length !== image.width * image.height) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), structuredRing: { enabled: false, attempted: false, accepted: false } };
  }

  const consensusResult = options.consensus === false
    ? { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data), structuredConsensus: { enabled: false, attempted: false, accepted: false } }
    : applyStructuredConsensusRepair(image, alphaMap, { enabled: true, ...(options.consensusOptions || {}) });
  const consensus = consensusResult.structuredConsensus || { enabled: true, attempted: true, accepted: false };
  const working = consensus.accepted
    ? { width: consensusResult.width, height: consensusResult.height, data: consensusResult.data }
    : image;

  const before = measurePostCleanupResidual(working, alphaMap);
  const alignedBefore = measureStructuredRingResidual(working, alphaMap);
  const totalThreshold = Number.isFinite(options.totalThreshold) ? options.totalThreshold : 0.80;
  const lumaThreshold = Number.isFinite(options.lumaThreshold) ? options.lumaThreshold : 1.35;
  const shouldAttempt = before.total >= totalThreshold || before.luma >= lumaThreshold || alignedBefore.score >= 1.40;
  if (!shouldAttempt) {
    const ghostResult = finishWithShapeGhost(working, alphaMap, options);
    const shapeGhost = ghostResult.shapeGhost || { enabled: true, attempted: true, accepted: false };
    let selected = shapeGhost.accepted
      ? { width: ghostResult.width, height: ghostResult.height, data: ghostResult.data }
      : working;
    const seamResult = finishWithCenterSeam(selected, alphaMap, options);
    const centerSeam = seamResult.centerSeam || { enabled: true, attempted: true, accepted: false };
    if (centerSeam.accepted) selected = { width: seamResult.width, height: seamResult.height, data: seamResult.data };
    const toneResult = finishWithLocalTone(selected, alphaMap, options);
    const localToneMatch = toneResult.localToneMatch || { enabled: true, attempted: true, accepted: false };
    if (localToneMatch.accepted) selected = { width: toneResult.width, height: toneResult.height, data: toneResult.data };
    const haloResult = finishWithOuterHalo(selected, alphaMap, options);
    const outerHalo = haloResult.outerHalo || { enabled: true, attempted: true, accepted: false };
    if (outerHalo.accepted) selected = { width: haloResult.width, height: haloResult.height, data: haloResult.data };
    const refinement = {
      enabled: options.evidenceRefinement !== false,
      attempted: false,
      accepted: false,
      reason: 'primary-gate-not-triggered'
    };
    let acceptedMode = shapeGhost.accepted ? 'shape-ghost' : (consensus.accepted ? 'consensus' : 'none');
    acceptedMode = appendMode(acceptedMode, 'center-seam', centerSeam.accepted);
    acceptedMode = appendMode(acceptedMode, 'local-tone', localToneMatch.accepted);
    acceptedMode = appendMode(acceptedMode, 'outer-halo', outerHalo.accepted);
    return {
      width: selected.width,
      height: selected.height,
      data: selected === image ? new Uint8ClampedArray(image.data) : selected.data,
      structuredRing: {
        enabled: true,
        attempted: false,
        accepted: consensus.accepted || shapeGhost.accepted || centerSeam.accepted || localToneMatch.accepted || outerHalo.accepted,
        acceptedMode,
        before,
        after: before,
        alignedBefore,
        alignedAfter: alignedBefore,
        improvement: 0,
        correctedPixels: 0,
        salvageAttempted: false,
        salvageAccepted: false,
        refinement,
        consensus,
        shapeGhost,
        centerSeam,
        localToneMatch,
        outerHalo
      }
    };
  }

  const primaryStrength = options.strength ?? 0.50;
  const pass = applyStructuredRingPass(working, alphaMap, primaryStrength);
  const after = measurePostCleanupResidual(pass.image, alphaMap);
  const alignedAfter = measureStructuredRingResidual(pass.image, alphaMap);
  const totalImprovement = before.total > 1e-6 ? (before.total - after.total) / before.total : 0;
  const alignedImprovement = alignedBefore.score > 1e-6 ? (alignedBefore.score - alignedAfter.score) / alignedBefore.score : 0;
  const accepted = pass.correctedPixels > 0 && (totalImprovement >= 0.004 || alignedImprovement >= 0.015) && after.total <= before.total * 1.005 && after.luma <= before.luma * 1.01;
  let selected = accepted ? pass.image : working;
  let finalAfter = accepted ? after : before;
  let finalAlignedAfter = accepted ? alignedAfter : alignedBefore;
  let finalImprovement = accepted ? totalImprovement : 0;
  let finalAlignedImprovement = accepted ? alignedImprovement : 0;
  let finalCorrectedPixels = accepted ? pass.correctedPixels : 0;
  let finalMeanBlend = accepted ? pass.meanBlend : 0;
  let finalMeanAbsLumaDelta = accepted ? pass.meanAbsLumaDelta : 0;
  let salvageAttempted = false;
  let salvageAccepted = false;
  let salvageCandidateAfter = null;
  let salvageCandidateAlignedAfter = null;
  let salvageCandidatePixels = 0;
  const nearMissRatio = before.total > 1e-6 ? after.total / before.total : 1;
  const salvageEnabled = options.microSalvage !== false;
  const nearMiss = !accepted && pass.correctedPixels > 0 && nearMissRatio <= (Number.isFinite(options.salvageNearMissRatio) ? options.salvageNearMissRatio : 1.025) && after.luma <= before.luma * 1.025;
  if (salvageEnabled && nearMiss) {
    salvageAttempted = true;
    const salvageStrength = Math.max(0.08, Math.min(0.26, Number(primaryStrength) * (options.salvageStrengthScale ?? 0.35)));
    const salvagePass = applyStructuredRingPass(working, alphaMap, salvageStrength);
    salvageCandidateAfter = measurePostCleanupResidual(salvagePass.image, alphaMap);
    salvageCandidateAlignedAfter = measureStructuredRingResidual(salvagePass.image, alphaMap);
    salvageCandidatePixels = salvagePass.correctedPixels;
    const salvageImprovement = before.total > 1e-6 ? (before.total - salvageCandidateAfter.total) / before.total : 0;
    const salvageAlignedImprovement = alignedBefore.score > 1e-6 ? (alignedBefore.score - salvageCandidateAlignedAfter.score) / alignedBefore.score : 0;
    const salvageGood = salvagePass.correctedPixels > 0 && salvageCandidateAfter.total <= before.total * 0.998 && salvageCandidateAfter.luma <= before.luma * 1.002 && salvageCandidateAfter.chroma <= before.chroma * 1.01 && salvageCandidateAlignedAfter.score <= alignedBefore.score * 1.003 && (salvageImprovement >= 0.002 || salvageAlignedImprovement >= 0.008);
    if (salvageGood) {
      salvageAccepted = true;
      selected = salvagePass.image;
      finalAfter = salvageCandidateAfter;
      finalAlignedAfter = salvageCandidateAlignedAfter;
      finalImprovement = salvageImprovement;
      finalAlignedImprovement = salvageAlignedImprovement;
      finalCorrectedPixels = salvagePass.correctedPixels;
      finalMeanBlend = salvagePass.meanBlend;
      finalMeanAbsLumaDelta = salvagePass.meanAbsLumaDelta;
    }
  }

  const ringAccepted = accepted || salvageAccepted;
  const ghostResult = finishWithShapeGhost(selected, alphaMap, options);
  const shapeGhost = ghostResult.shapeGhost || { enabled: true, attempted: true, accepted: false };
  if (shapeGhost.accepted) selected = { width: ghostResult.width, height: ghostResult.height, data: ghostResult.data };

  const seamResult = finishWithCenterSeam(selected, alphaMap, options);
  const centerSeam = seamResult.centerSeam || { enabled: true, attempted: true, accepted: false };
  if (centerSeam.accepted) selected = { width: seamResult.width, height: seamResult.height, data: seamResult.data };

  const toneResult = finishWithLocalTone(selected, alphaMap, options);
  const localToneMatch = toneResult.localToneMatch || { enabled: true, attempted: true, accepted: false };
  if (localToneMatch.accepted) selected = { width: toneResult.width, height: toneResult.height, data: toneResult.data };

  const haloResult = finishWithOuterHalo(selected, alphaMap, options);
  const outerHalo = haloResult.outerHalo || { enabled: true, attempted: true, accepted: false };
  if (outerHalo.accepted) selected = { width: haloResult.width, height: haloResult.height, data: haloResult.data };

  const refinementResult = applyEvidenceGatedRefinement(selected, alphaMap, options);
  const refinement = refinementResult.state;
  if (refinement.accepted) selected = refinementResult.image;

  let acceptedMode = shapeGhost.accepted
    ? (accepted ? 'primary+shape-ghost' : (salvageAccepted ? 'micro-salvage+shape-ghost' : (consensus.accepted ? 'consensus+shape-ghost' : 'shape-ghost')))
    : (accepted ? 'primary' : (salvageAccepted ? 'micro-salvage' : (consensus.accepted ? 'consensus' : 'none')));
  acceptedMode = appendMode(acceptedMode, 'center-seam', centerSeam.accepted);
  acceptedMode = appendMode(acceptedMode, 'local-tone', localToneMatch.accepted);
  acceptedMode = appendMode(acceptedMode, 'outer-halo', outerHalo.accepted);
  acceptedMode = appendMode(acceptedMode, 'evidence-refine', refinement.accepted);

  return {
    width: selected.width,
    height: selected.height,
    data: selected === image ? new Uint8ClampedArray(image.data) : selected.data,
    structuredRing: {
      enabled: true,
      attempted: true,
      accepted: ringAccepted || consensus.accepted || shapeGhost.accepted || centerSeam.accepted || localToneMatch.accepted || outerHalo.accepted || refinement.accepted,
      ringAccepted,
      acceptedMode,
      before,
      after: finalAfter,
      candidateAfter: after,
      alignedBefore,
      alignedAfter: finalAlignedAfter,
      candidateAlignedAfter: alignedAfter,
      improvement: finalImprovement,
      alignedImprovement: finalAlignedImprovement,
      correctedPixels: finalCorrectedPixels,
      candidatePixels: pass.correctedPixels,
      meanBlend: finalMeanBlend,
      meanAbsLumaDelta: finalMeanAbsLumaDelta,
      salvageAttempted,
      salvageAccepted,
      salvageCandidateAfter,
      salvageCandidateAlignedAfter,
      salvageCandidatePixels,
      salvageNearMissRatio: nearMissRatio,
      refinement,
      consensus,
      shapeGhost,
      centerSeam,
      localToneMatch,
      outerHalo
    }
  };
}
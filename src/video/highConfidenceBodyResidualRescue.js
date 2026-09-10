import { measurePostCleanupResidual } from './edgeBridge.js';
import { measureGeometricOutlineResidual } from './protectedResidualRescue.js';
import { measureCrossingSceneEdgeRisk, sceneEdgeProtectionAt } from './sceneEdgeProtection.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luma(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function rgbAt(image, x, y) {
  const p = (y * image.width + x) * 4;
  return [image.data[p], image.data[p + 1], image.data[p + 2]];
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

const ORIENTATIONS = [
  [1, 0],
  [0, 1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2]
];

function cleanAnchor(image, alphaMap, x, y, dx, dy, sign, options = {}) {
  const cleanAlpha = Number.isFinite(options.cleanAlpha) ? options.cleanAlpha : 0.012;
  const maxRadius = Math.max(10, Math.min(36, Math.round(Number(options.maxRadius ?? 32))));
  for (let distance = 2; distance <= maxRadius; distance += 1) {
    const xx = Math.round(x + dx * distance * sign);
    const yy = Math.round(y + dy * distance * sign);
    if (xx < 2 || yy < 2 || xx >= image.width - 2 || yy >= image.height - 2) break;
    if ((alphaMap[yy * image.width + xx] || 0) > cleanAlpha) continue;
    return { rgb: rgbAt(image, xx, yy), distance };
  }
  return null;
}

function donorConsensus(image, alphaMap, x, y, options = {}) {
  const pairs = [];
  const pairSoft = Number.isFinite(options.pairSoft) ? options.pairSoft : 7;
  const pairHard = Number.isFinite(options.pairHard) ? options.pairHard : 28;
  const minPairAgreement = Number.isFinite(options.minPairAgreement) ? options.minPairAgreement : 0.50;

  for (const [dx, dy] of ORIENTATIONS) {
    const a = cleanAnchor(image, alphaMap, x, y, dx, dy, -1, options);
    const b = cleanAnchor(image, alphaMap, x, y, dx, dy, 1, options);
    if (!a || !b) continue;
    const ya = luma(a.rgb);
    const yb = luma(b.rgb);
    const chromaGap = Math.max(
      Math.abs(a.rgb[0] - b.rgb[0]),
      Math.abs(a.rgb[1] - b.rgb[1]),
      Math.abs(a.rgb[2] - b.rgb[2])
    );
    const gap = Math.abs(ya - yb) + chromaGap * 0.18;
    const agreement = 1 - smoothstep(pairSoft, pairHard, gap);
    if (agreement < minPairAgreement) continue;
    const span = a.distance + b.distance;
    if (span <= 0) continue;
    const wa = b.distance / span;
    const wb = a.distance / span;
    const target = [0, 1, 2].map((channel) => a.rgb[channel] * wa + b.rgb[channel] * wb);
    pairs.push({ target, targetY: luma(target), agreement });
  }

  const minDirections = Math.max(2, Math.min(4, Math.round(Number(options.minDirections ?? 2))));
  if (pairs.length < minDirections) return null;
  const target = [0, 1, 2].map((channel) => median(pairs.map((pair) => pair.target[channel])));
  const ys = pairs.map((pair) => pair.targetY);
  const spread = Math.max(...ys) - Math.min(...ys);
  const consensus = 1 - smoothstep(
    Number.isFinite(options.consensusSoft) ? options.consensusSoft : 6,
    Number.isFinite(options.consensusHard) ? options.consensusHard : 24,
    spread
  );
  const agreement = pairs.reduce((sum, pair) => sum + pair.agreement, 0) / pairs.length;
  return { target, targetY: luma(target), spread, consensus, agreement, directions: pairs.length };
}

function outlineMeasureOptions(options = {}) {
  return {
    outlineMinAlpha: Number.isFinite(options.outlineMinAlpha) ? options.outlineMinAlpha : 0.012,
    outlineMaxAlpha: Number.isFinite(options.outlineMaxAlpha) ? options.outlineMaxAlpha : 0.46,
    outlineResidualSoft: Number.isFinite(options.outlineResidualSoft) ? options.outlineResidualSoft : 0.40,
    outlineResidualHard: Number.isFinite(options.outlineResidualHard) ? options.outlineResidualHard : 3.6,
    hardSceneGuard: Number.isFinite(options.measureHardSceneGuard) ? options.measureHardSceneGuard : 0.72,
    sceneEdgeOptions: options.sceneEdgeOptions || {}
  };
}

function sceneGate(image, alphaMap, options = {}) {
  const risk = measureCrossingSceneEdgeRisk(image, alphaMap, options.sceneEdgeOptions || {});
  const maxScore = Number.isFinite(options.maxSceneScore) ? options.maxSceneScore : 0.22;
  const maxDensity = Number.isFinite(options.maxSceneDensity) ? options.maxSceneDensity : 0.050;
  const maxContinuityDensity = Number.isFinite(options.maxContinuityDensity) ? options.maxContinuityDensity : 0.028;
  const safe = !risk.protect
    && risk.level !== 'high'
    && (Number(risk.score) || 0) <= maxScore
    && (Number(risk.density) || 0) <= maxDensity
    && (Number(risk.continuityDensity) || 0) <= maxContinuityDensity;
  return { safe, risk, maxScore, maxDensity, maxContinuityDensity };
}

function buildCandidate(image, alphaMap, confidence, options = {}) {
  const data = new Uint8ClampedArray(image.data);
  const minAlpha = Number.isFinite(options.minAlpha) ? options.minAlpha : 0.075;
  const maxAlpha = Number.isFinite(options.maxAlpha) ? options.maxAlpha : 0.82;
  const scale = confidence < 0.78 ? 0.76 : 1;
  const strength = clamp(Number(options.strength ?? 0.38) * scale, 0.12, 0.42);
  const maxBlend = clamp(Number(options.maxBlend ?? 0.24) * scale, 0.08, 0.26);
  const maxLumaDelta = clamp(Number(options.maxLumaDelta ?? 9) * (0.84 + 0.16 * scale), 4, 10);
  const hardSceneGuard = confidence < 0.78
    ? Math.min(Number(options.hardSceneGuard ?? 0.34), 0.30)
    : Number(options.hardSceneGuard ?? 0.34);
  const minConsensus = Number.isFinite(options.minConsensus) ? options.minConsensus : 0.58;
  const residualSoft = Number.isFinite(options.residualSoft) ? options.residualSoft : 0.55;
  const residualHard = Number.isFinite(options.residualHard) ? options.residualHard : 4.2;

  let bodyPixels = 0;
  let donorPixels = 0;
  let correctedPixels = 0;
  let sceneGuardedPixels = 0;
  let lowConsensusPixels = 0;
  let blendSum = 0;
  let consensusSum = 0;
  let beforeResidualSum = 0;
  let afterResidualSum = 0;

  for (let y = 2; y < image.height - 2; y += 1) {
    for (let x = 2; x < image.width - 2; x += 1) {
      const p = y * image.width + x;
      const alpha = alphaMap[p] || 0;
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      bodyPixels += 1;

      const scene = sceneEdgeProtectionAt(image, alphaMap, x, y, options.sceneEdgeOptions || {});
      if (scene.weight >= hardSceneGuard) {
        sceneGuardedPixels += 1;
        continue;
      }

      const prediction = donorConsensus(image, alphaMap, x, y, options);
      if (!prediction || prediction.consensus < minConsensus) {
        lowConsensusPixels += 1;
        continue;
      }
      donorPixels += 1;

      const current = rgbAt(image, x, y);
      const currentY = luma(current);
      const residual = prediction.targetY - currentY;
      const residualGate = smoothstep(residualSoft, residualHard, Math.abs(residual));
      if (residualGate <= 0.02) continue;

      const bodyWeight = 0.68 + 0.32 * (1 - smoothstep(0.62, maxAlpha, alpha));
      const sceneAttenuation = clamp(1 - scene.weight * 1.55, 0, 1);
      const blend = Math.min(
        maxBlend,
        strength * prediction.consensus * prediction.agreement * residualGate * bodyWeight * sceneAttenuation
      );
      if (blend < 0.018) continue;

      const delta = clamp(residual, -maxLumaDelta, maxLumaDelta) * blend;
      const chromaBlend = Math.min(0.045, blend * 0.12);
      const idx = p * 4;
      const next = [0, 0, 0];
      for (let channel = 0; channel < 3; channel += 1) {
        const lumaAdjusted = current[channel] + delta;
        next[channel] = clampByte(lumaAdjusted + (prediction.target[channel] - lumaAdjusted) * chromaBlend);
        data[idx + channel] = next[channel];
      }

      const nextResidual = Math.abs(prediction.targetY - luma(next));
      const beforeResidual = Math.abs(residual);
      if (nextResidual + 0.01 >= beforeResidual) {
        data[idx] = image.data[idx];
        data[idx + 1] = image.data[idx + 1];
        data[idx + 2] = image.data[idx + 2];
        continue;
      }
      correctedPixels += 1;
      blendSum += blend;
      consensusSum += prediction.consensus;
      beforeResidualSum += beforeResidual;
      afterResidualSum += nextResidual;
    }
  }

  const localBeforeResidual = correctedPixels ? beforeResidualSum / correctedPixels : 0;
  const localAfterResidual = correctedPixels ? afterResidualSum / correctedPixels : 0;
  const localImprovement = localBeforeResidual > 1e-9
    ? (localBeforeResidual - localAfterResidual) / localBeforeResidual
    : 0;

  return {
    width: image.width,
    height: image.height,
    data,
    bodyPixels,
    donorPixels,
    correctedPixels,
    sceneGuardedPixels,
    lowConsensusPixels,
    guardedFraction: bodyPixels ? sceneGuardedPixels / bodyPixels : 0,
    meanBlend: correctedPixels ? blendSum / correctedPixels : 0,
    meanConsensus: correctedPixels ? consensusSum / correctedPixels : 0,
    localBeforeResidual,
    localAfterResidual,
    localImprovement,
    strength,
    maxBlend,
    maxLumaDelta,
    hardSceneGuard
  };
}

export function applyHighConfidenceBodyResidualRescue(image, alphaMap, options = {}) {
  const rawConfidence = Number(options.detectionConfidence);
  const confidence = Number.isFinite(rawConfidence) ? clamp(rawConfidence, 0, 1) : 0;
  const minDetectionConfidence = clamp(Number(options.minDetectionConfidence ?? 0.65), 0.40, 0.95);
  const beforeGlobal = measurePostCleanupResidual(image, alphaMap);
  const beforeOutline = measureGeometricOutlineResidual(image, alphaMap, outlineMeasureOptions(options));
  const scene = sceneGate(image, alphaMap, options);
  const confidenceSafe = confidence >= minDetectionConfidence;
  const eligible = options.enabled !== false
    && options.trigger !== false
    && confidenceSafe
    && scene.safe
    && alphaMap?.length === image.width * image.height;

  if (!eligible) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
      highConfidenceBodyResidualRescue: {
        enabled: options.enabled !== false,
        eligible,
        attempted: false,
        accepted: false,
        reason: !confidenceSafe ? 'confidence-gate' : (!scene.safe ? 'scene-risk-gate' : 'disabled-or-not-triggered'),
        confidence,
        minDetectionConfidence,
        sceneGate: scene,
        beforeGlobal,
        afterGlobal: beforeGlobal,
        beforeOutline,
        afterOutline: beforeOutline,
        correctedPixels: 0
      }
    };
  }

  const candidate = buildCandidate(image, alphaMap, confidence, options);
  const candidateImage = { width: image.width, height: image.height, data: candidate.data };
  const candidateAfterGlobal = measurePostCleanupResidual(candidateImage, alphaMap);
  const candidateAfterOutline = measureGeometricOutlineResidual(candidateImage, alphaMap, outlineMeasureOptions(options));

  const minCorrectedPixels = Math.max(4, Math.round(Number(options.minCorrectedPixels ?? 6)));
  const minLocalBeforeResidual = Number.isFinite(options.minLocalBeforeResidual) ? options.minLocalBeforeResidual : 1.0;
  const minLocalImprovement = Number.isFinite(options.minLocalImprovement) ? options.minLocalImprovement : 0.045;
  const minAcceptedConsensus = Number.isFinite(options.minAcceptedConsensus) ? options.minAcceptedConsensus : 0.60;
  const maxMeanBlend = Number.isFinite(options.maxAcceptedMeanBlend) ? options.maxAcceptedMeanBlend : 0.25;
  const maxGuardedFraction = Number.isFinite(options.maxGuardedFraction) ? options.maxGuardedFraction : 0.56;
  const outlineSafe = candidateAfterOutline.score <= beforeOutline.score * Number(options.maxOutlineRatio ?? 1.025) + 0.04;
  const globalSafe = candidateAfterGlobal.total <= beforeGlobal.total * Number(options.maxTotalRatio ?? 1.040) + 0.12
    && candidateAfterGlobal.luma <= beforeGlobal.luma * Number(options.maxLumaRatio ?? 1.045) + 0.15
    && candidateAfterGlobal.chroma <= beforeGlobal.chroma * Number(options.maxChromaRatio ?? 1.030) + 0.45;
  const localSafe = candidate.correctedPixels >= minCorrectedPixels
    && candidate.localBeforeResidual >= minLocalBeforeResidual
    && candidate.localImprovement >= minLocalImprovement
    && candidate.meanConsensus >= minAcceptedConsensus
    && candidate.meanBlend <= maxMeanBlend
    && candidate.guardedFraction <= maxGuardedFraction;
  const accepted = localSafe && outlineSafe && globalSafe;

  return {
    width: image.width,
    height: image.height,
    data: accepted ? new Uint8ClampedArray(candidate.data) : new Uint8ClampedArray(image.data),
    highConfidenceBodyResidualRescue: {
      enabled: true,
      eligible: true,
      attempted: candidate.donorPixels > 0,
      accepted,
      reason: accepted ? 'high-confidence-body-local-improvement' : 'candidate-rejected',
      confidence,
      minDetectionConfidence,
      sceneGate: scene,
      beforeGlobal,
      afterGlobal: accepted ? candidateAfterGlobal : beforeGlobal,
      candidateAfterGlobal,
      beforeOutline,
      afterOutline: accepted ? candidateAfterOutline : beforeOutline,
      candidateAfterOutline,
      bodyPixels: candidate.bodyPixels,
      donorPixels: candidate.donorPixels,
      correctedPixels: accepted ? candidate.correctedPixels : 0,
      candidateCorrectedPixels: candidate.correctedPixels,
      sceneGuardedPixels: candidate.sceneGuardedPixels,
      lowConsensusPixels: candidate.lowConsensusPixels,
      guardedFraction: candidate.guardedFraction,
      meanBlend: accepted ? candidate.meanBlend : 0,
      candidateMeanBlend: candidate.meanBlend,
      meanConsensus: candidate.meanConsensus,
      localBeforeResidual: candidate.localBeforeResidual,
      localAfterResidual: candidate.localAfterResidual,
      localImprovement: candidate.localImprovement,
      localSafe,
      outlineSafe,
      globalSafe,
      minCorrectedPixels,
      minLocalBeforeResidual,
      minLocalImprovement,
      minAcceptedConsensus,
      maxMeanBlend,
      maxGuardedFraction,
      strength: candidate.strength,
      maxBlend: candidate.maxBlend,
      maxLumaDelta: candidate.maxLumaDelta,
      hardSceneGuard: candidate.hardSceneGuard
    }
  };
}

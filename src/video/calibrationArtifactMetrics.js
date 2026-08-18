import { measureCenterSeamResidual } from './centerSeamSuppress.js';
import { measureLocalToneMismatch } from './localToneMatch.js';
import { measureOuterHaloResidual } from './outerHaloSuppress.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function finiteScore(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function component(score, confidence, weight, cap) {
  const safeWeight = Math.max(0, Number(weight) || 0);
  const safeConfidence = clamp(Number(confidence) || 0, 0, 1);
  const safeScore = Math.min(Math.max(0, finiteScore(score)), Math.max(1, Number(cap) || 16));
  return {
    score: safeScore,
    confidence: safeConfidence,
    weight: safeWeight,
    effectiveWeight: safeWeight * safeConfidence,
    weighted: safeScore * safeWeight * safeConfidence
  };
}

/**
 * Measures residual artifacts that the basic calibration score can underweight:
 * a narrow center seam, footprint-wide local tone offset and a 1-2 px exterior halo.
 *
 * This function is measurement-only. It does not alter pixels and is intentionally
 * separate from the calibrator until candidate-subset ranking is validated.
 */
export function measureCalibrationArtifactResidual(image, alphaMap, options = {}) {
  if (!image || !alphaMap || alphaMap.length !== image.width * image.height) {
    return {
      score: 0,
      coverage: 0,
      effectiveWeight: 0,
      seam: null,
      tone: null,
      halo: null,
      components: null
    };
  }

  const seam = measureCenterSeamResidual(image, alphaMap, options.centerSeamOptions || {});
  const tone = measureLocalToneMismatch(image, alphaMap, options.localToneOptions || {});
  const halo = measureOuterHaloResidual(image, alphaMap, options.outerHaloOptions || {});

  const seamConfidence = smoothstep(options.seamMinSamples ?? 4, options.seamFullSamples ?? 14, seam.samples || 0);
  const toneTargetConfidence = smoothstep(options.toneMinSamples ?? 10, options.toneFullSamples ?? 30, tone.samples || 0);
  const toneReferenceConfidence = smoothstep(
    options.toneMinReferenceSamples ?? 12,
    options.toneFullReferenceSamples ?? 44,
    tone.referenceSamples || 0
  );
  const toneConfidence = toneTargetConfidence * toneReferenceConfidence;
  const haloConfidence = smoothstep(options.haloMinSamples ?? 6, options.haloFullSamples ?? 18, halo.samples || 0);

  const weights = {
    seam: Number.isFinite(options.seamWeight) ? options.seamWeight : 0.28,
    tone: Number.isFinite(options.toneWeight) ? options.toneWeight : 0.44,
    halo: Number.isFinite(options.haloWeight) ? options.haloWeight : 0.28
  };
  const cap = Number.isFinite(options.componentCap) ? options.componentCap : 16;
  const components = {
    seam: component(seam.score, seamConfidence, weights.seam, cap),
    tone: component(tone.score, toneConfidence, weights.tone, cap),
    halo: component(halo.score, haloConfidence, weights.halo, cap)
  };

  const requestedWeight = Math.max(1e-9, components.seam.weight + components.tone.weight + components.halo.weight);
  const effectiveWeight = components.seam.effectiveWeight + components.tone.effectiveWeight + components.halo.effectiveWeight;
  const weighted = components.seam.weighted + components.tone.weighted + components.halo.weighted;
  const score = effectiveWeight > 1e-9 ? weighted / effectiveWeight : 0;

  return {
    score,
    coverage: clamp(effectiveWeight / requestedWeight, 0, 1),
    effectiveWeight,
    seam,
    tone,
    halo,
    components
  };
}

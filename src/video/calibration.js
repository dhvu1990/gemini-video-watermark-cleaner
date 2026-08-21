import { getVideoAlphaMap } from './alpha.js';
import { applyEdgePolish, inverseAlphaRestore } from './restore.js';
import { measureCalibrationArtifactResidual } from './calibrationArtifactMetrics.js';
import { rerankCalibrationCandidates } from './calibrationRerank.js';

const PROFILES = ['96-20260520', '96'];
const SHAPE_SCALES = [0.985, 1.0, 1.015];
const EDGE_BOOSTS = [0.03, 0.055, 0.085];
const EDGE_GAINS = [1.0, 1.15, 1.3];
const BODY_GAIN_FACTORS = [0.78, 0.88, 0.98, 1.08];
const LOW_GAIN_ANCHORS = [0.10, 0.16, 0.24, 0.34, 0.46];
const SUBPIXEL_OFFSETS = [-0.4, 0, 0.4];

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function luma(data, idx) { return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]; }

function sampleAlpha(alphaMap, size, x, y) {
  if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a00 = alphaMap[y0 * size + x0] || 0;
  const a10 = alphaMap[y0 * size + x1] || 0;
  const a01 = alphaMap[y1 * size + x0] || 0;
  const a11 = alphaMap[y1 * size + x1] || 0;
  return a00 * (1 - fx) * (1 - fy)
    + a10 * fx * (1 - fy)
    + a01 * (1 - fx) * fy
    + a11 * fx * fy;
}

export function transformAlphaRegistration(alphaMap, size, {
  scale = 1,
  offsetX = 0,
  offsetY = 0
} = {}) {
  const safeScale = clamp(Number(scale) || 1, 0.96, 1.04);
  const safeX = clamp(Number(offsetX) || 0, -0.75, 0.75);
  const safeY = clamp(Number(offsetY) || 0, -0.75, 0.75);
  if (Math.abs(safeScale - 1) < 1e-8 && Math.abs(safeX) < 1e-8 && Math.abs(safeY) < 1e-8) {
    return new Float32Array(alphaMap);
  }
  const out = new Float32Array(size * size);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = center + (x - center - safeX) / safeScale;
      const sy = center + (y - center - safeY) / safeScale;
      out[y * size + x] = sampleAlpha(alphaMap, size, sx, sy);
    }
  }
  return out;
}

export function scaleAlphaShape(alphaMap, size, scale = 1) {
  return transformAlphaRegistration(alphaMap, size, { scale });
}

export function applyEdgeGain(alphaMap, size, edgeGain = 1) {
  const gain = clamp(Number(edgeGain) || 1, 0.9, 1.45);
  if (Math.abs(gain - 1) < 1e-6) return new Float32Array(alphaMap);
  const gradient = new Float32Array(alphaMap.length);
  let maxGradient = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const p = y * size + x;
      const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gy = (alphaMap[p + size] || 0) - (alphaMap[p - size] || 0);
      gradient[p] = Math.hypot(gx, gy);
      maxGradient = Math.max(maxGradient, gradient[p]);
    }
  }
  const out = new Float32Array(alphaMap);
  for (let p = 0; p < out.length; p++) {
    const a = alphaMap[p] || 0;
    if (a <= 0.002) continue;
    const edge = maxGradient > 0 ? gradient[p] / maxGradient : 0;
    const lowAlpha = 1 - clamp((a - 0.08) / 0.42, 0, 1);
    const weight = clamp(edge * 0.72 + lowAlpha * 0.38, 0, 1);
    out[p] = clamp(a * (1 + (gain - 1) * weight), 0, 0.95);
  }
  return out;
}

function buildAlphaGradient(alphaMap, width, height) {
  const gradient = new Float32Array(alphaMap.length);
  let maxGradient = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const gx = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gy = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const value = Math.hypot(gx, gy);
      gradient[p] = value;
      maxGradient = Math.max(maxGradient, value);
    }
  }
  if (maxGradient > 0) for (let p = 0; p < gradient.length; p++) gradient[p] /= maxGradient;
  return gradient;
}

function residualBucket(alpha, gradient) {
  if (alpha <= 0.035) return 'nearZero';
  if (gradient >= 0.18) return 'edge';
  if (alpha >= 0.22) return 'highBody';
  return 'lowBody';
}

function safeAnchor(original, alphaMap, x, y, dx, dy) {
  const { width, height, data } = original;
  for (let step = 1; step < Math.max(width, height); step++) {
    const xx = x + dx * step;
    const yy = y + dy * step;
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) break;
    const p = yy * width + xx;
    if ((alphaMap[p] || 0) <= 0.008) {
      const i = p * 4;
      return { distance: step, rgb: [data[i], data[i + 1], data[i + 2]] };
    }
  }
  return null;
}

function interpolatePair(a, b) {
  if (!a && !b) return null;
  if (!a) return b.rgb;
  if (!b) return a.rgb;
  const total = a.distance + b.distance;
  return [0, 1, 2].map((c) => (a.rgb[c] * b.distance + b.rgb[c] * a.distance) / total);
}

function predictedBackground(original, alphaMap, x, y) {
  const horizontal = interpolatePair(
    safeAnchor(original, alphaMap, x, y, -1, 0),
    safeAnchor(original, alphaMap, x, y, 1, 0)
  );
  const vertical = interpolatePair(
    safeAnchor(original, alphaMap, x, y, 0, -1),
    safeAnchor(original, alphaMap, x, y, 0, 1)
  );
  if (!horizontal) return vertical;
  if (!vertical) return horizontal;
  return [0, 1, 2].map((c) => (horizontal[c] + vertical[c]) * 0.5);
}

export function backgroundContinuityScore(original, cleaned, alphaMap) {
  const { width, height } = original;
  let maskedError = 0;
  let maskedWeight = 0;
  let outsideDamage = 0;
  let outsideWeight = 0;
  let clippingPenalty = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      const idx = p * 4;
      if (a <= 0.008) {
        const delta = (
          Math.abs(cleaned.data[idx] - original.data[idx]) +
          Math.abs(cleaned.data[idx + 1] - original.data[idx + 1]) +
          Math.abs(cleaned.data[idx + 2] - original.data[idx + 2])
        ) / 3;
        outsideDamage += delta;
        outsideWeight++;
        continue;
      }

      const predicted = predictedBackground(original, alphaMap, x, y);
      if (!predicted) continue;
      const gxA = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gyA = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const edgeWeight = clamp(Math.hypot(gxA, gyA) * 10, 0, 1);
      const alphaWeight = 0.35 + 0.65 * clamp(a / 0.42, 0, 1);
      const weight = alphaWeight * (0.8 + edgeWeight * 0.45);
      let error = 0;
      for (let c = 0; c < 3; c++) {
        const value = cleaned.data[idx + c];
        error += Math.abs(value - predicted[c]);
        if ((value <= 3 || value >= 252) && predicted[c] > 12 && predicted[c] < 243) clippingPenalty += weight;
      }
      maskedError += (error / 3) * weight;
      maskedWeight += weight;
    }
  }

  const continuity = maskedWeight ? maskedError / maskedWeight : Number.POSITIVE_INFINITY;
  const outside = outsideWeight ? outsideDamage / outsideWeight : 0;
  return continuity + outside * 2.2 + (maskedWeight ? clippingPenalty / maskedWeight * 5 : 0);
}

export function residualEdgeScore(original, cleaned, alphaMap) {
  const { width, height } = original;
  let residual = 0;
  let texturePenalty = 0;
  let residualWeight = 0;
  let textureWeight = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const a = alphaMap[p] || 0;
      const gxA = (alphaMap[p + 1] || 0) - (alphaMap[p - 1] || 0);
      const gyA = (alphaMap[p + width] || 0) - (alphaMap[p - width] || 0);
      const edgeWeight = clamp(Math.hypot(gxA, gyA) * 9 + (a > 0.008 && a < 0.22 ? 0.35 : 0), 0, 1);
      const idx = p * 4;
      const left = (p - 1) * 4, right = (p + 1) * 4, up = (p - width) * 4, down = (p + width) * 4;
      const cleanGrad = Math.hypot(luma(cleaned.data, right) - luma(cleaned.data, left), luma(cleaned.data, down) - luma(cleaned.data, up));
      if (edgeWeight > 0.03) {
        residual += cleanGrad * edgeWeight;
        residualWeight += edgeWeight;
      }
      if (a < 0.008) {
        const delta = Math.abs(luma(cleaned.data, idx) - luma(original.data, idx));
        texturePenalty += delta;
        textureWeight++;
      }
    }
  }
  const edgeResidual = residualWeight ? residual / residualWeight : 0;
  const outsideDamage = textureWeight ? texturePenalty / textureWeight : 0;
  return edgeResidual + outsideDamage * 1.8;
}

export function residualBucketScores(original, cleaned, alphaMap) {
  const { width, height } = original;
  const gradient = buildAlphaGradient(alphaMap, width, height);
  const sums = { nearZero: 0, edge: 0, lowBody: 0, highBody: 0 };
  const counts = { nearZero: 0, edge: 0, lowBody: 0, highBody: 0 };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const alpha = alphaMap[p] || 0;
      const bucket = residualBucket(alpha, gradient[p] || 0);
      const idx = p * 4;
      let error = 0;
      if (bucket === 'nearZero') {
        error = (
          Math.abs(cleaned.data[idx] - original.data[idx]) +
          Math.abs(cleaned.data[idx + 1] - original.data[idx + 1]) +
          Math.abs(cleaned.data[idx + 2] - original.data[idx + 2])
        ) / 3;
      } else {
        const predicted = predictedBackground(original, alphaMap, x, y);
        if (!predicted) continue;
        error = (
          Math.abs(cleaned.data[idx] - predicted[0]) +
          Math.abs(cleaned.data[idx + 1] - predicted[1]) +
          Math.abs(cleaned.data[idx + 2] - predicted[2])
        ) / 3;
        if (bucket === 'edge') {
          const cleanGrad = Math.hypot(
            luma(cleaned.data, (p + 1) * 4) - luma(cleaned.data, (p - 1) * 4),
            luma(cleaned.data, (p + width) * 4) - luma(cleaned.data, (p - width) * 4)
          );
          error += cleanGrad * 0.18;
        }
      }
      sums[bucket] += error;
      counts[bucket]++;
    }
  }

  const scores = Object.fromEntries(Object.keys(sums).map((key) => [key, counts[key] ? sums[key] / counts[key] : 0]));
  scores.total = scores.edge * 0.46 + scores.lowBody * 0.22 + scores.highBody * 0.18 + scores.nearZero * 0.14;
  return scores;
}

function candidateScore(original, cleaned, alphaMap) {
  const buckets = residualBucketScores(original, cleaned, alphaMap);
  const continuity = backgroundContinuityScore(original, cleaned, alphaMap);
  return { total: buckets.total * 0.72 + continuity * 0.28, buckets };
}

export function bodyGainCandidates(estimate = 1, { minimumGain = 0.55, includeLowGainAnchors = false } = {}) {
  const floor = clamp(Number(minimumGain) || 0.55, 0.08, 0.55);
  const safeEstimate = clamp(Number(estimate) || 1, floor, 1.35);
  const anchors = includeLowGainAnchors ? LOW_GAIN_ANCHORS : [];
  const values = [...BODY_GAIN_FACTORS.map((factor) => safeEstimate * factor), ...anchors, 1];
  return [...new Set(values.map((value) => clamp(value, floor, 1.35).toFixed(4)))].map(Number).sort((a, b) => a - b);
}

export async function buildCalibratedAlphaMap(size, calibration = {}) {
  const profile = calibration.profile || '96-20260520';
  const shapeScale = Number.isFinite(calibration.shapeScale) ? calibration.shapeScale : 1;
  const edgeBoost = Number.isFinite(calibration.edgeBoost) ? calibration.edgeBoost : 0.055;
  const edgeGain = Number.isFinite(calibration.edgeGain) ? calibration.edgeGain : 1;
  const offsetX = Number.isFinite(calibration.offsetX) ? calibration.offsetX : 0;
  const offsetY = Number.isFinite(calibration.offsetY) ? calibration.offsetY : 0;
  const base = await getVideoAlphaMap(size, profile, edgeBoost);
  const shaped = transformAlphaRegistration(base, size, { scale: shapeScale, offsetX, offsetY });
  return applyEdgeGain(shaped, size, edgeGain);
}

function scoreSamples(samples, alphaMap, bodyGain, edgePolish, polish = true) {
  let total = 0;
  const bucketTotals = { nearZero: 0, edge: 0, lowBody: 0, highBody: 0, total: 0 };
  for (const roi of samples) {
    let cleaned = inverseAlphaRestore(roi, alphaMap, bodyGain);
    if (polish) cleaned = applyEdgePolish(cleaned, alphaMap, edgePolish);
    const score = candidateScore(roi, cleaned, alphaMap);
    total += score.total;
    for (const key of Object.keys(bucketTotals)) bucketTotals[key] += score.buckets[key] || 0;
  }
  const count = Math.max(1, samples.length);
  for (const key of Object.keys(bucketTotals)) bucketTotals[key] /= count;
  return { total: total / count, buckets: bucketTotals };
}

function scoreUnmodifiedSamples(samples, alphaMap) {
  let total = 0;
  const bucketTotals = { nearZero: 0, edge: 0, lowBody: 0, highBody: 0, total: 0 };
  for (const roi of samples) {
    const score = candidateScore(roi, roi, alphaMap);
    total += score.total;
    for (const key of Object.keys(bucketTotals)) bucketTotals[key] += score.buckets[key] || 0;
  }
  const count = Math.max(1, samples.length);
  for (const key of Object.keys(bucketTotals)) bucketTotals[key] /= count;
  return { total: total / count, buckets: bucketTotals };
}

function scoreArtifactSamples(samples, alphaMap, bodyGain, edgePolish) {
  let weightedScore = 0;
  let coverageSum = 0;
  const details = [];
  for (const roi of samples) {
    let cleaned = inverseAlphaRestore(roi, alphaMap, bodyGain);
    cleaned = applyEdgePolish(cleaned, alphaMap, edgePolish);
    const artifact = measureCalibrationArtifactResidual(cleaned, alphaMap);
    details.push(artifact);
    weightedScore += artifact.score * artifact.coverage;
    coverageSum += artifact.coverage;
  }
  const count = Math.max(1, samples.length);
  return {
    score: coverageSum > 1e-9 ? weightedScore / coverageSum : 0,
    coverage: clamp(coverageSum / count, 0, 1),
    samples: details
  };
}

export async function calibrateAlphaShape({
  rois,
  size,
  bodyGain = 1,
  edgePolish = 0.35,
  onProgress,
  artifactRerank = true,
  artifactTopN = 4,
  artifactWeight = 0.055,
  artifactMaxRelativeGap = 0.02,
  artifactMaxAbsoluteGap = 0.20,
  minimumBodyGain = 0.55,
  lowGainSearch = false,
  compareToNoCleanup = false
}) {
  const samples = (rois || []).filter(Boolean).slice(0, 3);
  if (!samples.length) return null;

  const gainFloor = clamp(Number(minimumBodyGain) || 0.55, 0.08, 0.55);
  const initialBodyGain = clamp(Number(bodyGain) || 1, gainFloor, 1.35);
  const baselineMap = await buildCalibratedAlphaMap(size, {
    profile: '96-20260520', shapeScale: 1, edgeBoost: 0.03, edgeGain: 1, offsetX: 0, offsetY: 0
  });
  const cleanupBaseline = scoreSamples(samples, baselineMap, initialBodyGain, edgePolish, true);
  const baseline = compareToNoCleanup ? scoreUnmodifiedSamples(samples, baselineMap) : cleanupBaseline;

  let selectedBodyGain = initialBodyGain;
  let selectedBodyScore = Number.POSITIVE_INFINITY;
  for (const gain of bodyGainCandidates(initialBodyGain, { minimumGain: gainFloor, includeLowGainAnchors: lowGainSearch })) {
    const score = scoreSamples(samples, baselineMap, gain, 0, false).total;
    if (score < selectedBodyScore) {
      selectedBodyScore = score;
      selectedBodyGain = gain;
    }
  }

  let best = {
    profile: '96-20260520',
    shapeScale: 1,
    edgeBoost: 0.03,
    edgeGain: 1,
    offsetX: 0,
    offsetY: 0,
    bodyGain: selectedBodyGain,
    residualScore: Number.POSITIVE_INFINITY,
    residualBuckets: null,
    alphaMap: baselineMap
  };
  let bestSelectionScore = Number.POSITIVE_INFINITY;
  const candidates = [];

  let index = 0;
  const coarseTotal = PROFILES.length * SHAPE_SCALES.length * EDGE_BOOSTS.length * EDGE_GAINS.length;
  const total = coarseTotal + SUBPIXEL_OFFSETS.length * SUBPIXEL_OFFSETS.length;
  for (const profile of PROFILES) {
    for (const shapeScale of SHAPE_SCALES) {
      for (const edgeBoost of EDGE_BOOSTS) {
        for (const edgeGain of EDGE_GAINS) {
          index++;
          const alphaMap = await buildCalibratedAlphaMap(size, { profile, shapeScale, edgeBoost, edgeGain, offsetX: 0, offsetY: 0 });
          const score = scoreSamples(samples, alphaMap, selectedBodyGain, edgePolish, true);
          const candidate = {
            profile, shapeScale, edgeBoost, edgeGain, offsetX: 0, offsetY: 0,
            bodyGain: selectedBodyGain,
            residualScore: score.total,
            residualBuckets: score.buckets,
            selectionScore: score.total,
            alphaMap
          };
          candidates.push(candidate);
          if (candidate.selectionScore < bestSelectionScore) {
            best = candidate;
            bestSelectionScore = candidate.selectionScore;
          }
          if (index % 6 === 0) onProgress?.({ index, total, progress: index / total, phase: 'coarse-alpha-fit' });
        }
      }
    }
  }

  const coarseBest = { ...best };
  for (const offsetY of SUBPIXEL_OFFSETS) {
    for (const offsetX of SUBPIXEL_OFFSETS) {
      index++;
      const alphaMap = await buildCalibratedAlphaMap(size, {
        profile: coarseBest.profile,
        shapeScale: coarseBest.shapeScale,
        edgeBoost: coarseBest.edgeBoost,
        edgeGain: coarseBest.edgeGain,
        offsetX,
        offsetY
      });
      const score = scoreSamples(samples, alphaMap, selectedBodyGain, edgePolish, true);
      const offsetPenalty = (Math.abs(offsetX) + Math.abs(offsetY)) * 0.025;
      const candidate = {
        profile: coarseBest.profile,
        shapeScale: coarseBest.shapeScale,
        edgeBoost: coarseBest.edgeBoost,
        edgeGain: coarseBest.edgeGain,
        offsetX,
        offsetY,
        bodyGain: selectedBodyGain,
        residualScore: score.total,
        residualBuckets: score.buckets,
        selectionScore: score.total + offsetPenalty,
        offsetPenalty,
        alphaMap
      };
      candidates.push(candidate);
      if (candidate.selectionScore < bestSelectionScore) {
        best = candidate;
        bestSelectionScore = candidate.selectionScore;
      }
      onProgress?.({ index, total, progress: index / total, phase: 'subpixel-alpha-fit' });
    }
  }

  if (artifactRerank !== false) {
    const reranked = await rerankCalibrationCandidates(
      candidates,
      async (candidate, artifactIndex, artifactTotal) => {
        const artifact = scoreArtifactSamples(samples, candidate.alphaMap, selectedBodyGain, edgePolish);
        onProgress?.({
          index: total,
          total,
          progress: 1,
          phase: 'artifact-rerank',
          artifactIndex: artifactIndex + 1,
          artifactTotal
        });
        return artifact;
      },
      {
        topN: artifactTopN,
        artifactWeight,
        maxRelativePenalty: 0.10,
        maxRelativeGap: artifactMaxRelativeGap,
        maxAbsoluteGap: artifactMaxAbsoluteGap
      }
    );
    if (reranked.selected) {
      best = reranked.selected;
      best.artifactRerank = {
        topN: reranked.topN,
        inputCount: reranked.inputCount,
        uniqueCount: reranked.uniqueCount,
        duplicateCount: reranked.duplicateCount,
        eligibleCount: reranked.eligibleCount,
        excludedByGap: reranked.excludedByGap,
        bestSelectionScore: reranked.bestSelectionScore,
        maxRelativeGap: reranked.maxRelativeGap,
        maxAbsoluteGap: reranked.maxAbsoluteGap,
        evaluated: reranked.evaluated.map((candidate) => ({
          profile: candidate.profile,
          shapeScale: candidate.shapeScale,
          edgeBoost: candidate.edgeBoost,
          edgeGain: candidate.edgeGain,
          offsetX: candidate.offsetX,
          offsetY: candidate.offsetY,
          residualScore: candidate.residualScore,
          selectionScore: candidate.selectionScore,
          artifactScore: candidate.artifactResidual?.score || 0,
          artifactCoverage: candidate.artifactResidual?.coverage || 0,
          finalScore: candidate.finalScore
        }))
      };
      best.calibrationScore = reranked.selected.finalScore;
    }
  }

  best.initialBodyGain = initialBodyGain;
  best.baselineScore = baseline.total;
  best.baselineBuckets = baseline.buckets;
  best.cleanupBaselineScore = cleanupBaseline.total;
  best.cleanupBaselineBuckets = cleanupBaseline.buckets;
  best.baselineMode = compareToNoCleanup ? 'no-cleanup' : 'default-cleanup';
  best.minimumBodyGain = gainFloor;
  best.lowGainSearch = Boolean(lowGainSearch);
  best.bodyOnlyScore = selectedBodyScore;
  best.improvement = baseline.total > 0 ? clamp((baseline.total - best.residualScore) / baseline.total, -1, 1) : 0;
  return best;
}

import { resolveVideoWatermarkCandidates } from './catalog.js';
import { getVideoAlphaMap, setActiveAlphaCalibration } from './alpha.js';
import { calibrateAlphaShape } from './calibration.js';
import { measureCrossingSceneEdgeRisk } from './sceneEdgeProtection.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function luma(data, idx) { return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]; }

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const aa = a[i] - ma;
    const bb = b[i] - mb;
    num += aa * bb;
    da += aa * aa;
    db += bb * bb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function alphaGradient(alpha, size, x, y) {
  const xm = Math.max(0, x - 1), xp = Math.min(size - 1, x + 1);
  const ym = Math.max(0, y - 1), yp = Math.min(size - 1, y + 1);
  const gx = alpha[y * size + xp] - alpha[y * size + xm];
  const gy = alpha[yp * size + x] - alpha[ym * size + x];
  return Math.hypot(gx, gy);
}

export function scoreRegion(imageData, position, alphaMap) {
  const size = position.width ?? position.size;
  const lum = [];
  const alpha = [];
  const lumGrad = [];
  const alphaGrad = [];
  const { data, width, height } = imageData;

  for (let y = 1; y < size - 1; y++) {
    const yy = position.y + y;
    if (yy <= 0 || yy >= height - 1) continue;
    for (let x = 1; x < size - 1; x++) {
      const xx = position.x + x;
      if (xx <= 0 || xx >= width - 1) continue;
      const a = alphaMap[y * size + x] || 0;
      const idx = (yy * width + xx) * 4;
      lum.push(luma(data, idx));
      alpha.push(a);
      if (a > 0.004) {
        const gx = luma(data, (yy * width + xx + 1) * 4) - luma(data, (yy * width + xx - 1) * 4);
        const gy = luma(data, ((yy + 1) * width + xx) * 4) - luma(data, ((yy - 1) * width + xx) * 4);
        lumGrad.push(Math.hypot(gx, gy));
        alphaGrad.push(alphaGradient(alphaMap, size, x, y));
      }
    }
  }

  const spatial = correlation(lum, alpha);
  const gradient = correlation(lumGrad, alphaGrad);
  const confidence = Math.max(0, spatial) * 0.35 + Math.max(0, gradient) * 0.65;
  return { spatial, gradient, confidence };
}

function aggregate(scores) {
  const values = scores.map((item) => item.confidence).sort((a, b) => b - a);
  if (!values.length) return { confidence: 0, voteRatio: 0, maxConfidence: 0 };
  const keep = Math.max(1, Math.ceil(values.length * 0.6));
  const topMean = values.slice(0, keep).reduce((a, b) => a + b, 0) / keep;
  const voteRatio = values.filter((value) => value >= 0.08).length / values.length;
  return { confidence: topMean * 0.9 + voteRatio * 0.1, voteRatio, maxConfidence: values[0] };
}

async function evaluateCandidate(frames, candidate) {
  const detectionProfile = candidate.size < 40 ? '48' : '96-20260520';
  const alphaMap = await getVideoAlphaMap(candidate.size, detectionProfile, 0);
  const scores = frames.map((frame) => scoreRegion(frame.imageData, candidate, alphaMap));
  return { candidate, alphaMap, scores, ...aggregate(scores) };
}

async function refineCandidate(frames, base, radiusOverride = null) {
  const radius = Number.isFinite(radiusOverride)
    ? Math.max(2, Math.round(radiusOverride))
    : Math.max(2, Math.min(6, Math.round(base.candidate.size * 0.08)));
  const step = 2;
  const probes = frames.length <= 5 ? frames : frames.filter((_, i) => i % Math.ceil(frames.length / 5) === 0).slice(0, 5);
  let best = base;
  let bestRank = base.confidence;

  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const c = { ...base.candidate, x: base.candidate.x + dx, y: base.candidate.y + dy, id: `${base.candidate.id}@${dx},${dy}` };
      if (c.x < 0 || c.y < 0 || c.x + c.size > probes[0].imageData.width || c.y + c.size > probes[0].imageData.height) continue;
      const scores = probes.map((frame) => scoreRegion(frame.imageData, c, base.alphaMap));
      const summary = aggregate(scores);
      const rank = summary.confidence - (Math.abs(dx) + Math.abs(dy)) / Math.max(1, c.size) * 0.004;
      if (rank > bestRank) {
        best = { candidate: c, alphaMap: base.alphaMap, scores, ...summary };
        bestRank = rank;
      }
    }
  }
  return best;
}

export function buildRegionalSearchPositions(width, height, size) {
  const safeSize = Math.max(16, Math.round(size));
  const minMargin = Math.max(12, Math.round(safeSize * 0.28));
  const maxMargin = Math.max(minMargin, Math.min(
    Math.round(safeSize * 3.4),
    Math.round(Math.min(width, height) * 0.24)
  ));
  const step = Math.max(6, Math.round(safeSize * 0.16));
  const out = [];
  for (let marginBottom = minMargin; marginBottom <= maxMargin; marginBottom += step) {
    for (let marginRight = minMargin; marginRight <= maxMargin; marginRight += step) {
      const x = Math.round(width - marginRight - safeSize);
      const y = Math.round(height - marginBottom - safeSize);
      if (x < 0 || y < 0 || x + safeSize > width || y + safeSize > height) continue;
      out.push({ x, y, size: safeSize, width: safeSize, height: safeSize, marginRight, marginBottom });
    }
  }
  return out;
}

function signatureSupport(scores = []) {
  if (!scores.length) return { supportRatio: 0, positiveSpatialRatio: 0, positiveGradientRatio: 0 };
  const support = scores.filter((score) => score.confidence >= 0.08 && score.spatial > 0.015 && score.gradient > 0.015).length;
  const spatial = scores.filter((score) => score.spatial > 0.02).length;
  const gradient = scores.filter((score) => score.gradient > 0.02).length;
  return {
    supportRatio: support / scores.length,
    positiveSpatialRatio: spatial / scores.length,
    positiveGradientRatio: gradient / scores.length
  };
}

function cropRoi(imageData, position) {
  const size = position.width ?? position.size;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const start = ((position.y + y) * imageData.width + position.x) * 4;
    data.set(imageData.data.subarray(start, start + size * 4), y * size * 4);
  }
  return { width: size, height: size, data };
}

function regionalSceneEdgeSupport(frames = [], candidate, alphaMap) {
  if (!frames.length || !candidate || !alphaMap) {
    return { protectRatio: 0, highRatio: 0, meanScore: 0, meanDensity: 0, samples: 0 };
  }
  const risks = frames.map((frame) => measureCrossingSceneEdgeRisk(cropRoi(frame.imageData, candidate), alphaMap));
  const samples = risks.length;
  const protectRatio = risks.filter((risk) => risk.protect).length / samples;
  const highRatio = risks.filter((risk) => risk.level === 'high').length / samples;
  const meanScore = risks.reduce((sum, risk) => sum + (Number(risk.score) || 0), 0) / samples;
  const meanDensity = risks.reduce((sum, risk) => sum + (Number(risk.density) || 0), 0) / samples;
  return { protectRatio, highRatio, meanScore, meanDensity, samples };
}

function distinctCandidate(a, b) {
  if (!a?.candidate || !b?.candidate) return true;
  const acx = a.candidate.x + a.candidate.size / 2;
  const acy = a.candidate.y + a.candidate.size / 2;
  const bcx = b.candidate.x + b.candidate.size / 2;
  const bcy = b.candidate.y + b.candidate.size / 2;
  const distance = Math.hypot(acx - bcx, acy - bcy);
  return distance >= Math.max(10, Math.min(a.candidate.size, b.candidate.size) * 0.58);
}

export function evaluateRegionalSearchSafety({
  confidence,
  voteRatio,
  maxConfidence,
  scores = [],
  minConfidence = 0.12,
  sceneEdge = null,
  runnerUpConfidence = null
} = {}) {
  const score = Number(confidence) || 0;
  const threshold = Math.max(Number.isFinite(minConfidence) ? minConfidence : 0.12, 0.14);
  const vote = Number(voteRatio) || 0;
  const peak = Number(maxConfidence) || 0;
  const signature = signatureSupport(scores);
  const edge = sceneEdge || { protectRatio: 0, highRatio: 0, meanScore: 0, meanDensity: 0, samples: 0 };
  const runnerUp = Number(runnerUpConfidence);
  const dominanceGap = Number.isFinite(runnerUp) ? score - runnerUp : null;

  if (score < threshold) return { safe: false, reason: 'regional-low-confidence', signature, sceneEdge: edge, dominanceGap };
  if (vote < 0.60) return { safe: false, reason: 'regional-low-vote', signature, sceneEdge: edge, dominanceGap };
  if (peak < Math.max(0.10, threshold * 0.75)) return { safe: false, reason: 'regional-weak-peak', signature, sceneEdge: edge, dominanceGap };
  if (signature.supportRatio < 0.50 || signature.positiveSpatialRatio < 0.50 || signature.positiveGradientRatio < 0.50) {
    return { safe: false, reason: 'regional-signature-inconsistent', signature, sceneEdge: edge, dominanceGap };
  }

  const persistentSceneEdge = edge.samples >= 3 && (
    (edge.protectRatio >= 0.50 && edge.meanScore >= 0.20) ||
    (edge.highRatio >= 0.34 && edge.meanDensity >= 0.022) ||
    (edge.protectRatio >= 0.75 && edge.meanDensity >= 0.014)
  );
  if (persistentSceneEdge) {
    return { safe: false, reason: 'regional-persistent-scene-edge', signature, sceneEdge: edge, dominanceGap };
  }

  if (Number.isFinite(dominanceGap) && score < 0.55) {
    const requiredGap = Math.max(0.022, score * 0.075);
    if (dominanceGap < requiredGap) {
      return { safe: false, reason: 'regional-ambiguous-runner-up', signature, sceneEdge: edge, dominanceGap, requiredGap };
    }
  }

  return { safe: true, reason: 'regional-signature-match', signature, sceneEdge: edge, dominanceGap };
}

async function searchRegionalCandidate(frames, width, height, candidates) {
  const sizes = [...new Set(candidates.map((candidate) => candidate.size))];
  const probes = frames.length <= 4 ? frames : [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1]];
  const results = [];

  for (const size of sizes) {
    const detectionProfile = size < 40 ? '48' : '96-20260520';
    const alphaMap = await getVideoAlphaMap(size, detectionProfile, 0);
    const positions = buildRegionalSearchPositions(width, height, size);
    const shortlist = [];
    for (const position of positions) {
      const candidate = { ...position, id: `veo-regional-${size}` };
      const scores = probes.map((frame) => scoreRegion(frame.imageData, candidate, alphaMap));
      const summary = aggregate(scores);
      shortlist.push({ candidate, alphaMap, scores, ...summary });
    }
    shortlist.sort((a, b) => b.confidence - a.confidence);
    for (const coarse of shortlist.slice(0, 4)) {
      const refined = await refineCandidate(probes, coarse, Math.max(4, Math.round(size * 0.14)));
      const fullScores = frames.map((frame) => scoreRegion(frame.imageData, refined.candidate, alphaMap));
      const summary = aggregate(fullScores);
      results.push({ candidate: refined.candidate, alphaMap, scores: fullScores, ...summary, source: 'regional-search' });
    }
  }

  if (!results.length) return null;
  results.sort((a, b) => b.confidence - a.confidence);
  const best = results[0];
  const runnerUp = results.slice(1).find((candidate) => distinctCandidate(best, candidate)) || null;
  best.runnerUpConfidence = runnerUp?.confidence ?? null;
  best.sceneEdge = regionalSceneEdgeSupport(frames, best.candidate, best.alphaMap);
  return best;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export function estimateAlphaGain(imageData, position, alphaMap) {
  const size = position.width ?? position.size;
  let backgroundSum = 0;
  let backgroundCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = alphaMap[y * size + x] || 0;
      if (a > 0.02) continue;
      const idx = ((position.y + y) * imageData.width + position.x + x) * 4;
      backgroundSum += luma(imageData.data, idx);
      backgroundCount++;
    }
  }
  if (!backgroundCount) return 1;
  const background = backgroundSum / backgroundCount;
  const gains = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = alphaMap[y * size + x] || 0;
      if (a < 0.10 || a > 0.75) continue;
      const idx = ((position.y + y) * imageData.width + position.x + x) * 4;
      const observed = luma(imageData.data, idx);
      const denom = a * Math.max(12, 255 - background);
      if (denom <= 0) continue;
      const gain = (observed - background) / denom;
      if (gain >= 0.45 && gain <= 1.55) gains.push(gain);
    }
  }
  return clamp(median(gains) ?? 1, 0.65, 1.35);
}

export function evaluateDetectionSafety({ confidence, minConfidence = 0.12, refinement = null } = {}) {
  const score = Number(confidence) || 0;
  const threshold = Number.isFinite(minConfidence) ? minConfidence : 0.12;
  if (score < threshold) return { safe: false, reason: 'low-confidence', refinement };
  if (!refinement) return { safe: true, reason: 'threshold-match', refinement: null };

  const size = Math.max(1, Number(refinement.size) || 1);
  const dx = Number(refinement.dx) || 0;
  const dy = Number(refinement.dy) || 0;
  const distance = Math.hypot(dx, dy);
  const maxDistance = Math.max(3, Math.min(6, size * 0.09));
  const axisLimit = Math.max(3, Math.min(5, size * 0.075));
  const broadDrift = distance > maxDistance || Math.abs(dx) > axisLimit || Math.abs(dy) > axisLimit;

  if (broadDrift && score < 0.55) {
    return {
      safe: false,
      reason: 'unsafe-refinement-drift',
      refinement: { ...refinement, distance, maxDistance, axisLimit }
    };
  }

  return {
    safe: true,
    reason: broadDrift ? 'strong-match-refinement' : 'anchor-consistent-match',
    refinement: { ...refinement, distance, maxDistance, axisLimit }
  };
}

export async function detectVideoWatermarkFromFrames({ frames, width, height, minConfidence = 0.12, edgePolish = 0.35 }) {
  const candidates = resolveVideoWatermarkCandidates(width, height);
  if (!frames?.length || !candidates.length) return { detected: false, safeToClean: false, confidence: 0, reason: 'no-frames-or-candidates' };

  const evaluations = [];
  for (const candidate of candidates) evaluations.push(await evaluateCandidate(frames, candidate));
  evaluations.sort((a, b) => (b.confidence - b.candidate.priority * 0.001) - (a.confidence - a.candidate.priority * 0.001));
  const base = evaluations[0];
  let best = await refineCandidate(frames, base);
  let detectionSource = 'catalog-anchor';
  let regionalSafety = null;

  const anchoredSafetyProbe = evaluateDetectionSafety({
    confidence: best.confidence,
    minConfidence,
    refinement: {
      baseCandidateId: base.candidate.id,
      baseX: base.candidate.x,
      baseY: base.candidate.y,
      baseConfidence: base.confidence,
      dx: best.candidate.x - base.candidate.x,
      dy: best.candidate.y - base.candidate.y,
      size: best.candidate.size,
      confidenceGain: best.confidence - base.confidence
    }
  });

  if (!anchoredSafetyProbe.safe || best.confidence < Math.max(minConfidence + 0.04, 0.18)) {
    const regional = await searchRegionalCandidate(frames, width, height, candidates);
    if (regional) {
      regionalSafety = evaluateRegionalSearchSafety({
        confidence: regional.confidence,
        voteRatio: regional.voteRatio,
        maxConfidence: regional.maxConfidence,
        scores: regional.scores,
        minConfidence,
        sceneEdge: regional.sceneEdge,
        runnerUpConfidence: regional.runnerUpConfidence
      });
      const materiallyBetter = regional.confidence >= best.confidence + 0.035;
      const anchorFailed = !anchoredSafetyProbe.safe || best.confidence < minConfidence;
      if (regionalSafety.safe && (materiallyBetter || anchorFailed)) {
        best = regional;
        detectionSource = 'regional-search';
      }
    }
  }

  const refinement = detectionSource === 'catalog-anchor' ? {
    baseCandidateId: base.candidate.id,
    baseX: base.candidate.x,
    baseY: base.candidate.y,
    baseConfidence: base.confidence,
    dx: best.candidate.x - base.candidate.x,
    dy: best.candidate.y - base.candidate.y,
    size: best.candidate.size,
    confidenceGain: best.confidence - base.confidence
  } : null;

  const gains = frames
    .filter((_, index) => (best.scores[index]?.confidence ?? best.confidence) >= 0.05)
    .map((frame) => estimateAlphaGain(frame.imageData, best.candidate, best.alphaMap));
  const estimatedAlphaGain = clamp(median(gains) ?? 1, 0.65, 1.35);

  const preCalibrationSafety = detectionSource === 'regional-search'
    ? (regionalSafety || evaluateRegionalSearchSafety({
        confidence: best.confidence,
        voteRatio: best.voteRatio,
        maxConfidence: best.maxConfidence,
        scores: best.scores,
        minConfidence,
        sceneEdge: best.sceneEdge,
        runnerUpConfidence: best.runnerUpConfidence
      }))
    : evaluateDetectionSafety({ confidence: best.confidence, minConfidence, refinement });

  let calibration = null;
  if (preCalibrationSafety.safe) {
    const sourceFrames = frames.length <= 3 ? frames : [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1]];
    const rois = sourceFrames.map((frame) => cropRoi(frame.imageData, best.candidate));
    calibration = await calibrateAlphaShape({ rois, size: best.candidate.size, bodyGain: estimatedAlphaGain, edgePolish });
    if (calibration?.alphaMap) {
      best.alphaMap = calibration.alphaMap;
      setActiveAlphaCalibration(best.candidate.size, calibration.alphaMap, calibration);
    }
  }

  const safety = preCalibrationSafety;
  const detected = safety.safe;
  const alphaGain = Number.isFinite(calibration?.bodyGain) ? calibration.bodyGain : estimatedAlphaGain;
  return {
    detected,
    safeToClean: detected,
    reason: detected ? (detectionSource === 'regional-search' ? 'regional-signature-match' : 'multi-frame-match') : safety.reason,
    detectionSource,
    candidateId: best.candidate.id,
    confidence: best.confidence,
    voteRatio: best.voteRatio,
    maxConfidence: best.maxConfidence,
    position: { x: best.candidate.x, y: best.candidate.y, width: best.candidate.size, height: best.candidate.size },
    refinement: safety.refinement || refinement,
    regionalSafety: detectionSource === 'regional-search' ? safety : regionalSafety,
    safety,
    alphaGain,
    estimatedAlphaGain,
    calibration: calibration ? {
      profile: calibration.profile,
      shapeScale: calibration.shapeScale,
      offsetX: calibration.offsetX,
      offsetY: calibration.offsetY,
      edgeBoost: calibration.edgeBoost,
      edgeGain: calibration.edgeGain,
      bodyGain: calibration.bodyGain,
      initialBodyGain: calibration.initialBodyGain,
      residualScore: calibration.residualScore,
      residualBuckets: calibration.residualBuckets,
      baselineScore: calibration.baselineScore,
      baselineBuckets: calibration.baselineBuckets,
      improvement: calibration.improvement
    } : null,
    alphaMap: best.alphaMap,
    frameScores: best.scores
  };
}

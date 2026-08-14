import { resolveVideoWatermarkCandidates } from './catalog.js';
import { getVideoAlphaMap } from './alpha.js';

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
  return {
    confidence: topMean * 0.9 + voteRatio * 0.1,
    voteRatio,
    maxConfidence: values[0]
  };
}

async function evaluateCandidate(frames, candidate) {
  const alphaMap = await getVideoAlphaMap(candidate.size);
  const scores = frames.map((frame) => scoreRegion(frame.imageData, candidate, alphaMap));
  return { candidate, alphaMap, scores, ...aggregate(scores) };
}

async function refineCandidate(frames, base) {
  const radius = Math.max(4, Math.round(base.candidate.size * 0.22));
  const step = Math.max(2, Math.round(base.candidate.size / 18));
  const probes = frames.length <= 5 ? frames : frames.filter((_, i) => i % Math.ceil(frames.length / 5) === 0).slice(0, 5);
  let best = base;

  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const c = { ...base.candidate, x: base.candidate.x + dx, y: base.candidate.y + dy, id: `${base.candidate.id}@${dx},${dy}` };
      if (c.x < 0 || c.y < 0 || c.x + c.size > probes[0].imageData.width || c.y + c.size > probes[0].imageData.height) continue;
      const scores = probes.map((frame) => scoreRegion(frame.imageData, c, base.alphaMap));
      const summary = aggregate(scores);
      const rank = summary.confidence - (Math.abs(dx) + Math.abs(dy)) / Math.max(1, c.size) * 0.002;
      const bestRank = best.confidence;
      if (rank > bestRank) best = { candidate: c, alphaMap: base.alphaMap, scores, ...summary };
    }
  }
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

export async function detectVideoWatermarkFromFrames({ frames, width, height, minConfidence = 0.12 }) {
  const candidates = resolveVideoWatermarkCandidates(width, height);
  if (!frames?.length || !candidates.length) {
    return { detected: false, confidence: 0, reason: 'no-frames-or-candidates' };
  }

  const evaluations = [];
  for (const candidate of candidates) evaluations.push(await evaluateCandidate(frames, candidate));
  evaluations.sort((a, b) => (b.confidence - b.candidate.priority * 0.001) - (a.confidence - a.candidate.priority * 0.001));
  let best = evaluations[0];
  best = await refineCandidate(frames, best);
  const gains = frames
    .filter((_, index) => (best.scores[index]?.confidence ?? best.confidence) >= 0.05)
    .map((frame) => estimateAlphaGain(frame.imageData, best.candidate, best.alphaMap));
  const alphaGain = clamp(median(gains) ?? 1, 0.65, 1.35);

  return {
    detected: best.confidence >= minConfidence,
    reason: best.confidence >= minConfidence ? 'multi-frame-match' : 'low-confidence',
    candidateId: best.candidate.id,
    confidence: best.confidence,
    voteRatio: best.voteRatio,
    maxConfidence: best.maxConfidence,
    position: { x: best.candidate.x, y: best.candidate.y, width: best.candidate.size, height: best.candidate.size },
    alphaGain,
    alphaMap: best.alphaMap,
    frameScores: best.scores
  };
}

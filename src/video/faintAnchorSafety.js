function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function anchorId(refinement, candidateId) {
  return String(refinement?.baseCandidateId || candidateId || '').replace(/@[-\d]+,[-\d]+$/, '');
}

function knownExactAnchor(id) {
  return /^veo-(?:1080p|720p|portrait-1080|portrait-720)-(?:standard|inset|relocated|compact|mini)$/.test(id);
}

function signatureSupport(scores = []) {
  if (!scores.length) return { supportRatio: 0, spatialRatio: 0, gradientRatio: 0 };
  const support = scores.filter((item) => (Number(item?.spatial) || 0) > 0.012 && (Number(item?.gradient) || 0) > 0.018).length;
  const spatial = scores.filter((item) => (Number(item?.spatial) || 0) > 0.012).length;
  const gradient = scores.filter((item) => (Number(item?.gradient) || 0) > 0.018).length;
  return {
    supportRatio: support / scores.length,
    spatialRatio: spatial / scores.length,
    gradientRatio: gradient / scores.length
  };
}

export function evaluateFaintAnchorSafety({
  confidence,
  maxConfidence,
  minConfidence = 0.12,
  candidateId,
  refinement = null,
  scores = []
} = {}) {
  const score = clamp01(confidence);
  const threshold = Number.isFinite(minConfidence) ? minConfidence : 0.12;
  const peak = clamp01(maxConfidence);
  const id = anchorId(refinement, candidateId);
  const dx = Number(refinement?.dx) || 0;
  const dy = Number(refinement?.dy) || 0;
  const distance = Math.hypot(dx, dy);
  const signature = signatureSupport(scores);
  const ultraFaint = score < 0.045;

  if (score >= threshold) return { safe: false, reason: 'not-low-confidence', id, distance, signature, ultraFaint };
  if (score < 0.032) return { safe: false, reason: 'faint-anchor-too-weak', id, distance, signature, ultraFaint };
  if (!knownExactAnchor(id)) return { safe: false, reason: 'faint-anchor-not-exact-profile', id, distance, signature, ultraFaint };
  if (distance > 3.25 || Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    return { safe: false, reason: 'faint-anchor-drift', id, distance, signature, ultraFaint };
  }
  const minimumPeak = ultraFaint ? Math.max(0.042, score * 1.02) : Math.max(0.055, score * 0.92);
  if (peak < minimumPeak) {
    return { safe: false, reason: 'faint-anchor-weak-peak', id, distance, signature, ultraFaint, minimumPeak };
  }
  const minimumSupport = ultraFaint ? 0.67 : 0.50;
  const minimumGradient = ultraFaint ? 0.67 : 0.50;
  const minimumSpatial = ultraFaint ? 0.50 : 0.34;
  if (signature.supportRatio < minimumSupport || signature.gradientRatio < minimumGradient || signature.spatialRatio < minimumSpatial) {
    return {
      safe: false,
      reason: 'faint-anchor-inconsistent-signature',
      id,
      distance,
      signature,
      ultraFaint,
      requiredSignature: { supportRatio: minimumSupport, gradientRatio: minimumGradient, spatialRatio: minimumSpatial }
    };
  }

  return { safe: true, reason: ultraFaint ? 'ultra-faint-anchor-signature-match' : 'faint-anchor-signature-match', id, distance, signature, ultraFaint };
}

export function evaluateFaintAnchorCalibration({ safety, calibration } = {}) {
  if (!safety?.safe || !calibration) return { safe: false, reason: 'faint-anchor-no-calibration' };
  const improvement = Number(calibration.improvement);
  const baseline = Number(calibration.baselineScore);
  const residual = Number(calibration.residualScore);
  const finiteScores = Number.isFinite(baseline) && Number.isFinite(residual) && baseline > 0;
  if (!finiteScores) return { safe: false, reason: 'faint-anchor-invalid-calibration' };
  const minimumImprovement = safety.ultraFaint ? 0.028 : 0.018;
  const maximumResidualRatio = safety.ultraFaint ? 0.968 : 0.982;
  if (!Number.isFinite(improvement) || improvement < minimumImprovement) {
    return {
      safe: false,
      reason: 'faint-anchor-no-cleanup-improvement',
      improvement,
      baseline,
      residual,
      minimumImprovement,
      ultraFaint: Boolean(safety.ultraFaint)
    };
  }
  if (residual >= baseline * maximumResidualRatio) {
    return {
      safe: false,
      reason: 'faint-anchor-residual-not-improved',
      improvement,
      baseline,
      residual,
      maximumResidualRatio,
      ultraFaint: Boolean(safety.ultraFaint)
    };
  }
  return {
    safe: true,
    reason: 'faint-anchor-calibrated-match',
    improvement,
    baseline,
    residual,
    signature: safety.signature,
    id: safety.id,
    distance: safety.distance,
    ultraFaint: Boolean(safety.ultraFaint)
  };
}

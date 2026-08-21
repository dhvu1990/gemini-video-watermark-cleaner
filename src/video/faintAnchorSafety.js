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

function ultraFaintProbeEvidence({ score, peak, signature }) {
  // A probe is not permission to clean. It only permits low-gain calibration to run
  // at an exact catalog anchor. Promotion after the probe is intentionally much stricter.
  if (score < 0.032 || score >= 0.045) return { eligible: false, reason: 'not-ultra-faint-probe-range' };
  const minimumPeak = Math.max(0.034, score * 0.86);
  if (peak < minimumPeak) return { eligible: false, reason: 'probe-peak-too-weak', minimumPeak };
  const evidenceChannels = [
    signature.supportRatio >= 0.34,
    signature.gradientRatio >= 0.34,
    signature.spatialRatio >= 0.25
  ].filter(Boolean).length;
  if (evidenceChannels < 2) {
    return {
      eligible: false,
      reason: 'probe-signature-too-weak',
      evidenceChannels,
      requiredChannels: 2
    };
  }
  return { eligible: true, reason: 'ultra-faint-exact-anchor-probe', minimumPeak, evidenceChannels };
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
  const minimumSupport = ultraFaint ? 0.67 : 0.50;
  const minimumGradient = ultraFaint ? 0.67 : 0.50;
  const minimumSpatial = ultraFaint ? 0.50 : 0.34;
  const peakPass = peak >= minimumPeak;
  const signaturePass = signature.supportRatio >= minimumSupport
    && signature.gradientRatio >= minimumGradient
    && signature.spatialRatio >= minimumSpatial;

  if (peakPass && signaturePass) {
    return {
      safe: true,
      probeOnly: false,
      reason: ultraFaint ? 'ultra-faint-anchor-signature-match' : 'faint-anchor-signature-match',
      id,
      distance,
      signature,
      ultraFaint
    };
  }

  // v1.0.98: exact ultra-faint anchors may probe calibration even when the normal
  // signature gate is narrowly missed. This does NOT make them safe to clean yet.
  if (ultraFaint) {
    const probe = ultraFaintProbeEvidence({ score, peak, signature });
    if (probe.eligible) {
      return {
        safe: true,
        probeOnly: true,
        reason: probe.reason,
        id,
        distance,
        signature,
        ultraFaint,
        probe,
        normalGate: {
          peakPass,
          signaturePass,
          minimumPeak,
          requiredSignature: { supportRatio: minimumSupport, gradientRatio: minimumGradient, spatialRatio: minimumSpatial }
        }
      };
    }
  }

  if (!peakPass) {
    return { safe: false, reason: 'faint-anchor-weak-peak', id, distance, signature, ultraFaint, minimumPeak };
  }
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

export function evaluateFaintAnchorCalibration({ safety, calibration } = {}) {
  if (!safety?.safe || !calibration) return { safe: false, reason: 'faint-anchor-no-calibration' };
  const improvement = Number(calibration.improvement);
  const baseline = Number(calibration.baselineScore);
  const residual = Number(calibration.residualScore);
  const finiteScores = Number.isFinite(baseline) && Number.isFinite(residual) && baseline > 0;
  if (!finiteScores) return { safe: false, reason: 'faint-anchor-invalid-calibration' };

  const probeOnly = Boolean(safety.probeOnly);
  // Probe-only candidates entered calibration with weaker detector evidence, so they
  // must demonstrate a substantially stronger cleanup win before promotion.
  const minimumImprovement = probeOnly ? 0.075 : (safety.ultraFaint ? 0.028 : 0.018);
  const maximumResidualRatio = probeOnly ? 0.91 : (safety.ultraFaint ? 0.968 : 0.982);
  const bodyGain = Number(calibration.bodyGain);
  const lowGainPlausible = !probeOnly || (Number.isFinite(bodyGain) && bodyGain >= 0.10 && bodyGain <= 0.55);

  if (!lowGainPlausible) {
    return {
      safe: false,
      reason: 'faint-anchor-probe-gain-implausible',
      improvement,
      baseline,
      residual,
      bodyGain,
      probeOnly
    };
  }
  if (!Number.isFinite(improvement) || improvement < minimumImprovement) {
    return {
      safe: false,
      reason: probeOnly ? 'faint-anchor-probe-no-strong-improvement' : 'faint-anchor-no-cleanup-improvement',
      improvement,
      baseline,
      residual,
      minimumImprovement,
      ultraFaint: Boolean(safety.ultraFaint),
      probeOnly
    };
  }
  if (residual >= baseline * maximumResidualRatio) {
    return {
      safe: false,
      reason: probeOnly ? 'faint-anchor-probe-residual-not-improved' : 'faint-anchor-residual-not-improved',
      improvement,
      baseline,
      residual,
      maximumResidualRatio,
      ultraFaint: Boolean(safety.ultraFaint),
      probeOnly
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
    ultraFaint: Boolean(safety.ultraFaint),
    probeOnly,
    bodyGain
  };
}

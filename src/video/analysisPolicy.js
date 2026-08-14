export const QUICK_SAMPLE_COUNT = 3;
export const QUICK_SCAN_FRACTION = 0.18;

export function quickConfidenceThreshold(minConfidence = 0.12) {
  const min = Number.isFinite(minConfidence) ? minConfidence : 0.12;
  return Math.max(0.22, Math.min(0.95, min + 0.08));
}

export function shouldAcceptQuickDetection(detection, minConfidence = 0.12) {
  if (!detection?.detected) return false;
  const confidence = Number(detection.confidence);
  const voteRatio = Number(detection.voteRatio);
  return Number.isFinite(confidence)
    && confidence >= quickConfidenceThreshold(minConfidence)
    && (!Number.isFinite(voteRatio) || voteRatio >= 2 / 3);
}

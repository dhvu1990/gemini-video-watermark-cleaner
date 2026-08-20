function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function humanizeBatchCandidate(candidateId = '') {
  const label = String(candidateId || 'Gemini Veo')
    .replace(/@.*$/, '')
    .replace(/^veo-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
  return label || 'Gemini Veo';
}

export function batchBackgroundLabel(preview = null) {
  const mode = preview?.dualRingFinish?.smoothBackground?.mode || null;
  if (mode === 'empty-hard-rebuild') return 'Safe empty-zone hard suppression';
  if (mode === 'smooth-rebuild') return 'Smooth background rebuild';
  if (mode) return String(mode).replace(/-/g, ' ');
  return 'Structured-background fallback';
}

export function buildBatchDetectionView(detection = null, preview = null) {
  if (!detection) {
    return {
      ready: false,
      detected: false,
      confidence: 0,
      matchPercent: 0,
      candidateLabel: '-',
      title: 'Auto-detect pending',
      note: 'Waiting for automatic multi-frame analysis.',
      position: null,
      riskFlags: 'none'
    };
  }

  const confidence = Math.max(0, Math.min(1, finite(detection.confidence, 0)));
  const matchPercent = Math.round(confidence * 100);
  const candidateLabel = humanizeBatchCandidate(detection.candidateId || 'Gemini Veo');
  const detected = Boolean(detection.detected);
  const position = detection.position
    ? {
        x: Math.round(finite(detection.position.x, 0)),
        y: Math.round(finite(detection.position.y, 0)),
        width: Math.round(finite(detection.position.width, 0)),
        height: Math.round(finite(detection.position.height, detection.position.width || 0))
      }
    : null;
  const flags = Array.isArray(preview?.antiStreak?.riskFlags)
    ? preview.antiStreak.riskFlags.filter(Boolean)
    : [];

  return {
    ready: true,
    detected,
    confidence,
    matchPercent,
    candidateLabel,
    title: detected
      ? `Auto-detected: Gemini Veo — ${candidateLabel} (${matchPercent}% match)`
      : `Possible watermark candidate — ${candidateLabel} (${matchPercent}% match)`,
    note: batchBackgroundLabel(preview),
    position,
    riskFlags: flags.length ? flags.join(', ') : 'none'
  };
}

export function sameBatchInspectOptions(a = null, b = null) {
  if (!a || !b) return false;
  return Number(a.sampleCount) === Number(b.sampleCount)
    && Number(a.minConfidence) === Number(b.minConfidence)
    && Number(a.edgePolish) === Number(b.edgePolish)
    && Number(a.scanFraction) === Number(b.scanFraction);
}

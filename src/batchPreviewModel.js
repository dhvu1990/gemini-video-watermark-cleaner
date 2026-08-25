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
  const rescueMode = preview?.structuredSmoothRescue?.acceptedMode || null;
  if (rescueMode === 'final-visual-residual-rescue') return 'Final visual residual rescue';
  if (rescueMode === 'structured-smooth+final-visual') return 'Structured smooth + final visual rescue';
  if (rescueMode === 'structured-smooth-rescue') return 'Structured smooth residual rescue';
  const mode = preview?.dualRingFinish?.smoothBackground?.mode || null;
  if (mode === 'empty-hard-rebuild') return 'Safe empty-zone hard suppression';
  if (mode === 'smooth-rebuild') return 'Smooth background rebuild';
  if (mode) return String(mode).replace(/-/g, ' ');
  return 'Structured-background fallback';
}

function finalVisualRiskFlags(preview = null) {
  const finalResidual = preview?.structuredSmoothRescue?.finalVisualResidual || null;
  if (!finalResidual) return [];
  const before = finalResidual.before || {};
  const after = finalResidual.accepted ? (finalResidual.after || before) : before;
  const score = Math.max(0, finite(after.score, 0));
  const density = Math.max(0, finite(after.candidateDensity, 0));
  const samples = Math.max(0, Math.round(finite(after.samples, 0)));
  const flags = [];
  if (finalResidual.attempted && !finalResidual.accepted) flags.push('final-residual-rescue-rejected');
  if (score >= 1.20 && density >= 0.07 && samples >= 10) flags.push('final-visual-watermark-residual');
  return flags;
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
  const existingFlags = Array.isArray(preview?.antiStreak?.riskFlags)
    ? preview.antiStreak.riskFlags.filter(Boolean)
    : [];
  const flags = [...new Set([...existingFlags, ...finalVisualRiskFlags(preview)])];

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

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
  const rescue = preview?.structuredSmoothRescue || null;
  const rescueMode = rescue?.acceptedMode || null;
  const outline = rescue?.outlineResidualEscalation || null;
  const partial = outline?.partialSceneProtected === true;
  const contourOverride = outline?.contourBodyOverride === true;
  if (rescueMode?.includes('outline-escalation') && partial && contourOverride) return 'Protected contour-only outline rescue';
  if (rescueMode?.includes('outline-escalation') && partial) return 'Partial scene-protected outline rescue';
  if (rescueMode?.includes('outline-escalation') && contourOverride) return 'Contour-only outline rescue';
  if (rescueMode === 'final-visual-residual-rescue') return 'Final visual residual rescue';
  if (rescueMode === 'structured-smooth+final-visual') return 'Structured smooth + final visual rescue';
  if (rescueMode === 'outline-residual-escalation') return 'Outline residual escalation';
  if (rescueMode === 'structured-smooth+outline-escalation') return 'Structured smooth + outline escalation';
  if (rescueMode === 'final-visual+outline-escalation') return 'Final visual + outline escalation';
  if (rescueMode === 'structured-smooth+final-visual+outline-escalation') return 'Structured smooth + final visual + outline escalation';
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

function outlineResidualRiskFlags(preview = null) {
  const rescue = preview?.structuredSmoothRescue || null;
  if (!rescue) return [];
  const escalation = rescue.outlineResidualEscalation || null;
  const post = rescue.postChainOutlineResidual || null;
  const flags = [];

  if (escalation?.partialSceneProtected) flags.push('outline-partial-scene-protection');
  if (escalation?.contourBodyOverride) flags.push('outline-contour-body-override');
  if (escalation?.attempted && !escalation.accepted) flags.push('outline-residual-escalation-rejected');
  if (!post) return flags;

  const score = Math.max(0, finite(post.score, 0));
  const density = Math.max(0, finite(post.candidateDensity, 0));
  const samples = Math.max(0, Math.round(finite(post.samples, 0)));
  const sectors = Math.max(0, Math.round(finite(post.sectorSupport, 0)));
  const strong = post.strong === true || (score >= 1.15 && density >= 0.075 && samples >= 12 && sectors >= 3);
  if (!strong) return flags;

  if (!escalation?.attempted && escalation?.sceneMode === 'blocked') {
    flags.push('outline-scene-gate-blocked');
    const partial = escalation?.partialSceneGate || null;
    if (partial) {
      if (partial.evidenceStrong === false) flags.push('outline-partial-evidence-blocked');
      if (partial.safeCoverage === false) flags.push('outline-partial-safe-coverage-blocked');
      if (partial.globalComplexitySafe === false) flags.push('outline-partial-global-complexity-blocked');
      if (partial.contourLocalizationSafe === false) flags.push('outline-partial-localization-blocked');
    }
  }
  if (!escalation?.attempted && escalation?.bodyMode === 'blocked') {
    flags.push('outline-body-gate-blocked');
    const body = escalation?.bodyOverrideGate || null;
    if (body) {
      if (body.outlineStrong === false) flags.push('outline-body-outline-evidence-blocked');
      if (body.bodyBounded === false) flags.push('outline-body-score-blocked');
      if (body.dominanceSafe === false) flags.push('outline-body-dominance-blocked');
    }
  }

  const sceneEligible = escalation?.sceneEligible;
  const escalationSceneSafe = sceneEligible === undefined
    ? escalation?.sceneSafe !== false
    : sceneEligible !== false;
  const sceneSafe = rescue.postChainOutlineSceneSafe !== false && escalationSceneSafe;
  flags.push(sceneSafe ? 'post-chain-outline-watermark-residual' : 'post-chain-outline-scene-protected');
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
  const flags = [...new Set([
    ...existingFlags,
    ...finalVisualRiskFlags(preview),
    ...outlineResidualRiskFlags(preview)
  ])];

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

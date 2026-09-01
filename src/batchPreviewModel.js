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
  if (rescueMode?.includes('internal-residual') && rescueMode?.includes('contour-micro-interpolation')) return 'Contour + internal ghost/highlight rescue';
  if (rescueMode?.includes('internal-residual')) return 'Internal ghost/highlight rescue';
  if (rescueMode?.includes('contour-micro-interpolation')) return 'Contour micro-interpolation finishing';
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

function rejectedOutlineAcceptanceFlags(escalation = null) {
  if (!escalation?.attempted || escalation?.accepted) return [];
  const flags = [];
  const correctedPixels = Math.max(0, finite(escalation.candidateCorrectedPixels, 0));
  const meanBlend = Math.max(0, finite(escalation.candidateMeanBlend, 0));
  const improvement = finite(escalation.candidateImprovement, -Infinity);
  const minImprovement = finite(escalation.minImprovement, 0.035);
  const maxMeanBlend = finite(escalation.maxMeanBlend, 0.42);
  const beforeOutline = escalation.beforeOutline || escalation.outline || {};
  const afterOutline = escalation.candidateAfterOutline || {};
  const beforeGlobal = escalation.beforeGlobal || {};
  const afterGlobal = escalation.candidateAfterGlobal || {};
  const maxOutlineRatio = finite(escalation.maxOutlineRatio, 0.965);

  if (correctedPixels < 6) flags.push('outline-reject-too-few-pixels');
  if (meanBlend > maxMeanBlend) flags.push('outline-reject-mean-blend');
  if (improvement < minImprovement) flags.push('outline-reject-local-improvement');
  if (finite(afterOutline.score, Infinity) > finite(beforeOutline.score, 0) * maxOutlineRatio) {
    flags.push('outline-reject-outline-ratio');
  }
  if (finite(afterGlobal.total, Infinity) > finite(beforeGlobal.total, 0) * 1.005 + 0.05) {
    flags.push('outline-reject-global-total');
  }
  if (finite(afterGlobal.luma, Infinity) > finite(beforeGlobal.luma, 0) * 1.008 + 0.05) {
    flags.push('outline-reject-global-luma');
  }
  if (finite(afterGlobal.chroma, Infinity) > finite(beforeGlobal.chroma, 0) * 1.006 + 0.45) {
    flags.push('outline-reject-global-chroma');
  }
  if (!flags.length) flags.push('outline-reject-unclassified');
  return flags;
}

function microInterpolationRiskFlags(preview = null) {
  const micro = preview?.structuredSmoothRescue?.contourMicroInterpolation || null;
  if (!micro) return [];
  const flags = [];
  if (micro.accepted) flags.push('contour-micro-interpolation-accepted');
  else if (micro.attempted) {
    flags.push('contour-micro-interpolation-rejected');
    if (finite(micro.candidateCorrectedPixels, 0) < finite(micro.minCorrectedPixels, 6)) flags.push('micro-reject-too-few-pixels');
    if (finite(micro.candidateMeanBlend, 0) > finite(micro.maxMeanBlend, 0.28)) flags.push('micro-reject-mean-blend');
    if (finite(micro.candidateImprovement, -Infinity) < finite(micro.minImprovement, 0.006)) flags.push('micro-reject-local-improvement');
    const beforeOutline = micro.beforeOutline || {};
    const afterOutline = micro.candidateAfterOutline || {};
    if (finite(afterOutline.score, Infinity) > finite(beforeOutline.score, 0) * finite(micro.maxOutlineRatio, 0.994)) {
      flags.push('micro-reject-outline-ratio');
    }
  }
  return flags;
}

function internalResidualRiskFlags(preview = null) {
  const internal = preview?.structuredSmoothRescue?.internalResidualRescue || null;
  if (!internal) return [];
  const flags = [];
  if (internal.accepted) {
    flags.push('internal-residual-rescue-accepted');
    if (String(internal.acceptedMode || '').includes('highlight')) flags.push('internal-highlight-residual-accepted');
    if (String(internal.acceptedMode || '').includes('ghost')) flags.push('internal-ghost-residual-accepted');
  } else if (internal.attempted) {
    flags.push('internal-residual-rescue-rejected');
    if (internal.globalSafe === false) flags.push('internal-reject-global-safety');
    if (finite(internal.candidateCorrectedPixels, 0) <= 0) flags.push('internal-reject-no-candidate-pixels');
    if (finite(internal.candidateMeanBlend, 0) > 0.30) flags.push('internal-reject-mean-blend');
  }
  const before = internal.before || {};
  const after = internal.accepted ? (internal.after || before) : before;
  const score = Math.max(0, finite(after.score, 0));
  const density = Math.max(0, finite(after.candidateDensity, 0));
  const peak = Math.max(0, finite(after.maxResidual, 0));
  const highPixels = Math.max(0, Math.round(finite(after.highResidualPixels, 0)));
  if ((score >= 1.25 && density >= 0.04) || (peak >= 9 && highPixels >= 1)) flags.push('post-chain-internal-watermark-residual');
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
  if (escalation?.attempted && !escalation.accepted) {
    flags.push('outline-residual-escalation-rejected');
    flags.push(...rejectedOutlineAcceptanceFlags(escalation));
  }
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
    ...outlineResidualRiskFlags(preview),
    ...microInterpolationRiskFlags(preview),
    ...internalResidualRiskFlags(preview)
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

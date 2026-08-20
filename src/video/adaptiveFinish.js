function hardUnsafe(analysis) {
  if (!analysis?.coefficients || !analysis?.thresholds) return true;
  const t = analysis.thresholds;
  return analysis.complexity > t.maxComplexity * 1.35
    || analysis.surfaceMae > t.maxSurfaceMae * 1.40
    || analysis.edgeDensity > t.maxEdgeDensity * 1.50
    || analysis.meanGradient > t.maxMeanGradient * 1.50
    || analysis.meanLaplacian > t.maxMeanLaplacian * 1.50
    || analysis.coreStructureDensity > t.maxCoreStructureDensity * 1.35;
}

function preservationSafeSmooth(analysis, options = {}) {
  if (!analysis?.safe || !analysis?.coefficients) return false;
  const limits = {
    maxComplexity: Number.isFinite(options.preserveMaxComplexity) ? options.preserveMaxComplexity : 0.31,
    maxSurfaceMae: Number.isFinite(options.preserveMaxSurfaceMae) ? options.preserveMaxSurfaceMae : 7.4,
    maxEdgeDensity: Number.isFinite(options.preserveMaxEdgeDensity) ? options.preserveMaxEdgeDensity : 0.075,
    maxMeanGradient: Number.isFinite(options.preserveMaxMeanGradient) ? options.preserveMaxMeanGradient : 7.8,
    maxMeanLaplacian: Number.isFinite(options.preserveMaxMeanLaplacian) ? options.preserveMaxMeanLaplacian : 5.8,
    maxCoreStructureDensity: Number.isFinite(options.preserveMaxCoreStructureDensity) ? options.preserveMaxCoreStructureDensity : 0.145
  };
  return analysis.complexity <= limits.maxComplexity
    && analysis.surfaceMae <= limits.maxSurfaceMae
    && analysis.edgeDensity <= limits.maxEdgeDensity
    && analysis.meanGradient <= limits.maxMeanGradient
    && analysis.meanLaplacian <= limits.maxMeanLaplacian
    && analysis.coreStructureDensity <= limits.maxCoreStructureDensity;
}

const sharedState = {
  mode: null,
  frames: 0,
  smoothStreak: 0,
  structuredStreak: 0,
  switches: 0,
  heldFrames: 0
};

export function resetAdaptiveFinishState() {
  sharedState.mode = null;
  sharedState.frames = 0;
  sharedState.smoothStreak = 0;
  sharedState.structuredStreak = 0;
  sharedState.switches = 0;
  sharedState.heldFrames = 0;
}

export function stabilizeSmoothBackgroundMode(analysis, options = {}) {
  const state = sharedState;
  const rawSafe = Boolean(analysis?.safe);
  const preservationSafe = preservationSafeSmooth(analysis, options);
  const rawMode = rawSafe && preservationSafe ? 'smooth-rebuild' : 'structured';
  const preservationBlocked = rawSafe && !preservationSafe;
  const enterFrames = Math.max(1, Math.round(options.enterFrames ?? 2));
  const exitFrames = Math.max(1, Math.round(options.exitFrames ?? 2));
  const unsafeHard = rawMode === 'structured' && (preservationBlocked || hardUnsafe(analysis));
  state.frames++;

  if (!state.mode) {
    state.mode = rawMode;
    state.smoothStreak = rawMode === 'smooth-rebuild' ? 1 : 0;
    state.structuredStreak = rawMode === 'structured' ? 1 : 0;
    return {
      mode: state.mode,
      rawMode,
      held: false,
      switched: false,
      hardUnsafe: unsafeHard,
      preservationBlocked,
      reason: preservationBlocked ? 'detail-preservation-entry-guard' : 'initial-frame',
      temporal: { enabled: true, mode: state.mode, rawMode, switches: 0, heldFrames: 0 }
    };
  }

  let switched = false;
  let held = false;
  if (state.mode === 'smooth-rebuild') {
    if (rawMode === 'smooth-rebuild') {
      state.smoothStreak++;
      state.structuredStreak = 0;
    } else if (unsafeHard) {
      state.mode = 'structured';
      state.smoothStreak = 0;
      state.structuredStreak = 1;
      state.switches++;
      switched = true;
    } else {
      state.structuredStreak++;
      state.smoothStreak = 0;
      if (state.structuredStreak >= exitFrames) {
        state.mode = 'structured';
        state.switches++;
        switched = true;
      } else {
        held = true;
        state.heldFrames++;
      }
    }
  } else if (rawMode === 'smooth-rebuild') {
    state.smoothStreak++;
    state.structuredStreak = 0;
    if (state.smoothStreak >= enterFrames) {
      state.mode = 'smooth-rebuild';
      state.switches++;
      switched = true;
    } else {
      held = true;
      state.heldFrames++;
    }
  } else {
    state.structuredStreak++;
    state.smoothStreak = 0;
  }

  return {
    mode: state.mode,
    rawMode,
    held,
    switched,
    hardUnsafe: unsafeHard,
    preservationBlocked,
    reason: preservationBlocked
      ? 'detail-preservation-entry-guard'
      : (switched ? 'temporal-switch' : (held ? 'temporal-hold' : analysis?.reason || rawMode)),
    temporal: {
      enabled: true,
      mode: state.mode,
      rawMode,
      switches: state.switches,
      heldFrames: state.heldFrames,
      smoothStreak: state.smoothStreak,
      structuredStreak: state.structuredStreak
    }
  };
}

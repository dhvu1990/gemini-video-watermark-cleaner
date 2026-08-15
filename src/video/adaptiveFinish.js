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
  const rawMode = analysis?.safe ? 'smooth-rebuild' : 'structured';
  const enterFrames = Math.max(1, Math.round(options.enterFrames ?? 2));
  const exitFrames = Math.max(1, Math.round(options.exitFrames ?? 2));
  const unsafeHard = rawMode === 'structured' && hardUnsafe(analysis);
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
      reason: 'initial-frame',
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
    reason: switched ? 'temporal-switch' : (held ? 'temporal-hold' : analysis?.reason || rawMode),
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

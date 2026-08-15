import { applyDualRingLumaFinish } from './dualRingFinish.js';
import { analyzeSmoothBackground, applySmoothBackgroundReconstruction } from './smoothBackground.js';
import { measurePostCleanupResidual } from './edgeBridge.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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

export function stabilizeSmoothBackgroundMode(analysis, state = null, options = {}) {
  const rawMode = analysis?.safe ? 'smooth-rebuild' : 'structured';
  if (!state || typeof state !== 'object') {
    return {
      mode: rawMode,
      rawMode,
      held: false,
      switched: false,
      reason: analysis?.reason || 'no-analysis',
      hardUnsafe: !analysis?.safe && hardUnsafe(analysis),
      temporal: { enabled: false, mode: rawMode, rawMode, switches: 0, heldFrames: 0 }
    };
  }

  const enterFrames = Math.max(1, Math.round(options.enterFrames ?? 2));
  const exitFrames = Math.max(1, Math.round(options.exitFrames ?? 2));
  if (!Number.isFinite(state.frames)) state.frames = 0;
  if (!Number.isFinite(state.smoothStreak)) state.smoothStreak = 0;
  if (!Number.isFinite(state.structuredStreak)) state.structuredStreak = 0;
  if (!Number.isFinite(state.switches)) state.switches = 0;
  if (!Number.isFinite(state.heldFrames)) state.heldFrames = 0;

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
      reason: 'initial-frame',
      hardUnsafe: !analysis?.safe && hardUnsafe(analysis),
      temporal: { enabled: true, mode: state.mode, rawMode, switches: state.switches, heldFrames: state.heldFrames }
    };
  }

  let switched = false;
  let held = false;
  const unsafeHard = rawMode === 'structured' && hardUnsafe(analysis);

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
    reason: switched ? 'temporal-switch' : (held ? 'temporal-hold' : analysis?.reason || rawMode),
    hardUnsafe: unsafeHard,
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

export function applyAdaptiveFinalFinish(image, alphaMap, options = {}) {
  const base = applyDualRingLumaFinish(image, alphaMap, {
    ...options,
    smoothBackground: false
  });
  const baseImage = { width: base.width, height: base.height, data: base.data };
  const finalBefore = measurePostCleanupResidual(baseImage, alphaMap);

  const analysis = options.smoothBackground === false
    ? { safe: false, mode: 'structured', reason: 'disabled' }
    : analyzeSmoothBackground(baseImage, alphaMap, options.smoothBackgroundOptions || {});
  const decision = stabilizeSmoothBackgroundMode(
    analysis,
    options.smoothModeState || null,
    options.smoothModeOptions || {}
  );

  let selected = baseImage;
  let smoothBackground = {
    applied: false,
    ...analysis,
    mode: decision.mode,
    rawMode: decision.rawMode,
    temporal: decision.temporal,
    held: decision.held,
    switched: decision.switched,
    hardUnsafe: decision.hardUnsafe
  };

  if (decision.mode === 'smooth-rebuild' && analysis?.coefficients) {
    const candidate = applySmoothBackgroundReconstruction(baseImage, alphaMap, { ...analysis, safe: true }, {
      strength: options.smoothStrength ?? 0.995,
      dilationRadius: options.smoothDilationRadius ?? 4,
      microSmooth: options.smoothMicroBlur ?? 0.18
    });
    selected = { width: candidate.width, height: candidate.height, data: candidate.data };
    smoothBackground = {
      ...candidate.smoothBackground,
      mode: 'smooth-rebuild',
      rawMode: decision.rawMode,
      temporal: decision.temporal,
      held: decision.held,
      switched: decision.switched,
      hardUnsafe: decision.hardUnsafe
    };
  }

  const finalAfter = measurePostCleanupResidual(selected, alphaMap);
  const finalImprovement = finalBefore.total > 1e-6
    ? clamp((finalBefore.total - finalAfter.total) / finalBefore.total, -1, 1)
    : 0;
  const finalCleanup = {
    before: finalBefore,
    after: finalAfter,
    improvement: finalImprovement,
    source: smoothBackground.applied ? 'post-smooth-rebuild' : 'post-structured-finish'
  };

  return {
    width: selected.width,
    height: selected.height,
    data: selected.data,
    dualRingFinish: {
      ...(base.dualRingFinish || {}),
      smoothBackground,
      finalCleanup
    },
    smoothBackground,
    finalCleanup
  };
}

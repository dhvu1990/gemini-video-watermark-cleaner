import { evaluateFaintAnchorCalibration } from './video/faintAnchorSafety.js';

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function pct(value, digits = 1) {
  const n = finite(value);
  return n == null ? '-' : `${(n * 100).toFixed(digits)}%`;
}

function num(value, digits = 3) {
  const n = finite(value);
  return n == null ? '-' : n.toFixed(digits);
}

export function deriveFaintDetectionDiagnostics(detection = {}) {
  const faint = detection?.faintAnchorSafety || null;
  const calibration = detection?.calibration || null;
  let gateReason = detection?.reason || 'unknown';
  let calibrationSafety = null;

  if (!detection?.safeToClean && faint) {
    if (!faint.safe) {
      gateReason = faint.reason || gateReason;
    } else {
      calibrationSafety = evaluateFaintAnchorCalibration({ safety: faint, calibration });
      gateReason = calibrationSafety.reason || gateReason;
    }
  }

  const baseline = finite(calibration?.baselineScore);
  const residual = finite(calibration?.residualScore);
  const residualRatio = baseline != null && baseline > 0 && residual != null ? residual / baseline : null;
  const signature = faint?.signature || {};

  return {
    gateReason,
    anchor: detection?.candidateId || '-',
    detectionSource: detection?.detectionSource || '-',
    rawConfidence: finite(detection?.rawConfidence ?? detection?.confidence),
    maxConfidence: finite(detection?.maxConfidence),
    safeToClean: Boolean(detection?.safeToClean),
    faintReason: faint?.reason || '-',
    faintSafe: typeof faint?.safe === 'boolean' ? faint.safe : null,
    probeOnly: Boolean(faint?.probeOnly),
    ultraFaint: Boolean(faint?.ultraFaint),
    supportRatio: finite(signature?.supportRatio),
    gradientRatio: finite(signature?.gradientRatio),
    spatialRatio: finite(signature?.spatialRatio),
    bodyGain: finite(calibration?.bodyGain),
    improvement: finite(calibration?.improvement),
    baselineScore: baseline,
    residualScore: residual,
    residualRatio,
    lowGainSearch: Boolean(calibration?.lowGainSearch),
    baselineMode: calibration?.baselineMode || '-',
    calibrationSafety
  };
}

function ensureCard() {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById('faintDetectionDiagnostics');
  if (existing) return existing;
  const result = document.getElementById('detectResult');
  if (!result) return null;
  const card = document.createElement('div');
  card.id = 'faintDetectionDiagnostics';
  card.className = 'calibration-card';
  card.innerHTML = `
    <strong>Faint detection diagnostics</strong>
    <div class="row"><label>Final gate<input id="faintDiagGate" value="-" readonly /></label><label>Anchor<input id="faintDiagAnchor" value="-" readonly /></label></div>
    <div class="row triple"><label>Raw match<input id="faintDiagRaw" value="-" readonly /></label><label>Peak<input id="faintDiagPeak" value="-" readonly /></label><label>Probe only<input id="faintDiagProbe" value="-" readonly /></label></div>
    <div class="row triple"><label>Support<input id="faintDiagSupport" value="-" readonly /></label><label>Gradient<input id="faintDiagGradient" value="-" readonly /></label><label>Spatial<input id="faintDiagSpatial" value="-" readonly /></label></div>
    <div class="row triple"><label>Body gain<input id="faintDiagGain" value="-" readonly /></label><label>Improvement<input id="faintDiagImprovement" value="-" readonly /></label><label>Residual ratio<input id="faintDiagResidualRatio" value="-" readonly /></label></div>
    <div class="row"><label>Faint stage<input id="faintDiagStage" value="-" readonly /></label><label>Calibration mode<input id="faintDiagMode" value="-" readonly /></label></div>`;
  result.insertAdjacentElement('beforebegin', card);
  return card;
}

function setValue(id, value) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el) el.value = value;
}

function renderFromResult() {
  if (typeof document === 'undefined') return;
  const result = document.getElementById('detectResult');
  if (!result || !ensureCard()) return;
  let payload;
  try { payload = JSON.parse(result.textContent || '{}'); } catch { return; }
  const detection = payload?.detection;
  if (!detection) return;
  const d = deriveFaintDetectionDiagnostics(detection);
  setValue('faintDiagGate', d.gateReason);
  setValue('faintDiagAnchor', d.anchor);
  setValue('faintDiagRaw', pct(d.rawConfidence));
  setValue('faintDiagPeak', pct(d.maxConfidence));
  setValue('faintDiagProbe', d.probeOnly ? 'YES' : 'NO');
  setValue('faintDiagSupport', pct(d.supportRatio));
  setValue('faintDiagGradient', pct(d.gradientRatio));
  setValue('faintDiagSpatial', pct(d.spatialRatio));
  setValue('faintDiagGain', num(d.bodyGain, 3));
  setValue('faintDiagImprovement', pct(d.improvement));
  setValue('faintDiagResidualRatio', d.residualRatio == null ? '-' : num(d.residualRatio, 3));
  setValue('faintDiagStage', d.faintReason);
  setValue('faintDiagMode', d.lowGainSearch ? `low-gain / ${d.baselineMode}` : d.baselineMode);
}

export function mountFaintDetectionDiagnostics() {
  if (typeof document === 'undefined') return;
  const result = document.getElementById('detectResult');
  if (!result) return;
  ensureCard();
  new MutationObserver(renderFromResult).observe(result, { childList: true, subtree: true, characterData: true });
  renderFromResult();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountFaintDetectionDiagnostics, { once: true });
  else mountFaintDetectionDiagnostics();
}

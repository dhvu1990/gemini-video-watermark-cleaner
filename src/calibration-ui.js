const result = document.getElementById('detectResult');
const fields = {
  profile: document.getElementById('calProfile'),
  shapeScale: document.getElementById('calShape'),
  edgeGain: document.getElementById('calEdgeGain'),
  edgeBoost: document.getElementById('calEdgeBoost'),
  offsetX: document.getElementById('calOffsetX'),
  offsetY: document.getElementById('calOffsetY'),
  residualScore: document.getElementById('calResidual'),
  residualEdge: document.getElementById('calResidualEdge'),
  residualLow: document.getElementById('calResidualLow'),
  residualHigh: document.getElementById('calResidualHigh'),
  finalTotal: document.getElementById('finalResidualTotal'),
  finalLuma: document.getElementById('finalResidualLuma'),
  finalChroma: document.getElementById('finalResidualChroma'),
  finalImprovement: document.getElementById('finalResidualImprovement'),
  backgroundMode: document.getElementById('backgroundMode'),
  backgroundComplexity: document.getElementById('backgroundComplexity'),
  backgroundSurfaceMae: document.getElementById('backgroundSurfaceMae'),
  backgroundEdgeDensity: document.getElementById('backgroundEdgeDensity')
};
function reset() { for (const field of Object.values(fields)) if (field) field.value = '-'; }
function format(value, digits = 3) { return Number.isFinite(value) ? Number(value).toFixed(digits) : '-'; }
function deriveImprovement(calibration, finalCleanup) {
  const reported = finalCleanup?.improvement;
  if (Number.isFinite(reported) && Math.abs(reported) > 1e-6) return reported;
  const before = Number(calibration?.residualScore);
  const after = Number(finalCleanup?.after?.total);
  if (!Number.isFinite(before) || before <= 1e-6 || !Number.isFinite(after)) return null;
  return Math.max(-1, Math.min(1, (before - after) / before));
}
function render() {
  if (!result) return;
  try {
    const payload = JSON.parse(result.textContent || '{}');
    const calibration = payload?.detection?.calibration;
    if (!calibration) return reset();
    const buckets = calibration.residualBuckets || {};
    fields.profile.value = calibration.profile || '-';
    fields.shapeScale.value = format(calibration.shapeScale, 3);
    fields.edgeGain.value = format(calibration.edgeGain, 2);
    fields.edgeBoost.value = format(calibration.edgeBoost, 3);
    fields.offsetX.value = format(calibration.offsetX, 2);
    fields.offsetY.value = format(calibration.offsetY, 2);
    fields.residualScore.value = format(calibration.residualScore, 3);
    fields.residualEdge.value = format(buckets.edge, 3);
    fields.residualLow.value = format(buckets.lowBody, 3);
    fields.residualHigh.value = format(buckets.highBody, 3);
    const finalCleanup = payload?.finalCleanup;
    const after = finalCleanup?.after || {};
    if (fields.finalTotal) fields.finalTotal.value = format(after.total, 3);
    if (fields.finalLuma) fields.finalLuma.value = format(after.luma, 3);
    if (fields.finalChroma) fields.finalChroma.value = format(after.chroma, 3);
    const improvement = deriveImprovement(calibration, finalCleanup);
    if (fields.finalImprovement) fields.finalImprovement.value = Number.isFinite(improvement) ? `${(improvement * 100).toFixed(1)}%` : '-';
    const background = payload?.adaptiveBackground || {};
    if (fields.backgroundMode) fields.backgroundMode.value = background.mode || '-';
    if (fields.backgroundComplexity) fields.backgroundComplexity.value = format(background.complexity, 3);
    if (fields.backgroundSurfaceMae) fields.backgroundSurfaceMae.value = format(background.surfaceMae, 3);
    if (fields.backgroundEdgeDensity) fields.backgroundEdgeDensity.value = format(background.edgeDensity, 3);
  } catch { reset(); }
}
if (result) {
  new MutationObserver(render).observe(result, { childList: true, subtree: true, characterData: true });
  render();
}

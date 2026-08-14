const result = document.getElementById('detectResult');
const fields = {
  profile: document.getElementById('calProfile'),
  shapeScale: document.getElementById('calShape'),
  edgeGain: document.getElementById('calEdgeGain'),
  edgeBoost: document.getElementById('calEdgeBoost'),
  residualScore: document.getElementById('calResidual')
};

function reset() {
  for (const field of Object.values(fields)) if (field) field.value = '-';
}

function render() {
  if (!result) return;
  try {
    const payload = JSON.parse(result.textContent || '{}');
    const calibration = payload?.detection?.calibration;
    if (!calibration) return reset();
    fields.profile.value = calibration.profile || '-';
    fields.shapeScale.value = Number.isFinite(calibration.shapeScale) ? calibration.shapeScale.toFixed(3) : '-';
    fields.edgeGain.value = Number.isFinite(calibration.edgeGain) ? calibration.edgeGain.toFixed(2) : '-';
    fields.edgeBoost.value = Number.isFinite(calibration.edgeBoost) ? calibration.edgeBoost.toFixed(3) : '-';
    fields.residualScore.value = Number.isFinite(calibration.residualScore) ? calibration.residualScore.toFixed(3) : '-';
  } catch {
    reset();
  }
}

if (result) {
  new MutationObserver(render).observe(result, { childList: true, subtree: true, characterData: true });
  render();
}

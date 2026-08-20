function mountBatchPanel(doc = document) {
  if (!doc?.querySelector || doc.getElementById('batchPanel')) return false;
  const exportPanel = Array.from(doc.querySelectorAll('section.panel')).find((panel) => panel.querySelector('#cleanBtn'));
  if (!exportPanel) return false;

  // Keep the most frequent single-video actions together: choose a video, then clean/export it.
  const chooserPanel = doc.getElementById('dropZone')?.closest?.('section.panel') || null;
  if (chooserPanel && chooserPanel.nextElementSibling !== exportPanel) chooserPanel.after(exportPanel);
  const exportHeading = exportPanel.querySelector('h2');
  if (exportHeading) exportHeading.textContent = 'Quick clean / Export';
  exportPanel.classList.add('quick-export-panel');

  const panel = doc.createElement('section');
  panel.id = 'batchPanel';
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="preview-heading batch-heading">
      <div><p class="eyebrow">BATCH PROCESSING</p><h2>Process multiple videos</h2></div>
      <div id="batchSummary" class="muted">0 file(s) · 0 finished · 0 error(s)</div>
    </div>
    <input id="batchInput" type="file" accept="video/*,.mp4,.mov,.m4v,.webm" multiple hidden />
    <div class="actions batch-toolbar">
      <button id="chooseBatchBtn" type="button" class="secondary">Choose multiple videos</button>
      <button id="batchOutputFolderBtn" type="button" class="secondary">Choose output folder</button>
      <label class="batch-name-mode">Output name
        <select id="batchNameMode">
          <option value="cleaned" selected>Add -cleaned</option>
          <option value="original">Keep original name</option>
        </select>
      </label>
      <button id="batchCleanAllBtn" type="button" disabled>Clean all</button>
      <button id="batchCancelBtn" type="button" class="secondary" disabled>Cancel batch</button>
    </div>
    <div class="muted batch-folder">Output folder: <strong id="batchOutputFolderName">Not selected — results stay available as individual downloads.</strong></div>
    <div id="batchQueue" class="batch-queue"></div>
    <p class="muted batch-note">After selecting multiple videos, each file is auto-detected sequentially and shows its own original/cleaned watermark preview before Clean all. Cached detection is reused during cleaning when the settings have not changed. A single worker is reused across the queue and transient worker/network failures are retried automatically.</p>`;
  exportPanel.after(panel);

  const style = doc.createElement('style');
  style.textContent = `
    .quick-export-panel{border-color:#3a527e}.quick-export-panel .actions{margin-top:2px}
    .batch-heading{margin-bottom:12px}.batch-toolbar{align-items:end}.batch-name-mode{display:grid;gap:6px;margin:0;min-width:170px}
    .batch-name-mode select{border:1px solid #354565;background:#0c1325;color:#eef3ff;border-radius:10px;padding:10px 11px}
    .batch-folder{margin:12px 0}.batch-folder strong{color:#c9d7f2}.batch-queue{display:grid;gap:12px;margin-top:12px}
    .batch-row{display:grid;gap:12px;border:1px solid #2d3d60;border-radius:14px;padding:12px;background:#0a1121}
    .batch-row-top{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(220px,1fr) auto;gap:12px;align-items:center}
    .batch-name{min-width:0;display:grid;gap:4px}.batch-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.batch-name span,.batch-progress span{font-size:11px;color:#9aa6c1}
    .batch-progress{display:grid;gap:5px}.batch-progress-track{height:7px;border-radius:99px;overflow:hidden;background:#080d18;border:1px solid #26344f}.batch-progress-track i{display:block;height:100%;background:linear-gradient(90deg,#8eb7ff,#d8e7ff)}
    .batch-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.batch-actions button,.batch-actions .button{padding:8px 10px;font-size:12px}.status-error{border-color:#7a3945}.status-saved,.status-done{border-color:#2f6b57}.batch-note{margin:12px 0 0;font-size:12px}
    .batch-detection{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:14px;align-items:center;border-top:1px solid #243451;padding-top:12px}
    .batch-detect-summary{display:grid;gap:5px}.batch-detect-title{font-weight:750;color:#edf4ff;line-height:1.3}.batch-detect-meta{font-size:11px;color:#8fa5c9;overflow-wrap:anywhere}
    .batch-detection-analyzing .batch-detect-title{color:#9fc1ff}.batch-detection-error .batch-detect-title{color:#ff9eaa}
    .batch-detect-zooms{display:grid;grid-template-columns:repeat(2,92px);gap:8px}.batch-zoom-card{display:grid;gap:5px;border:1px solid #314466;border-radius:10px;padding:7px;background:#0d162a}.batch-zoom-card strong{font-size:9px;letter-spacing:.07em;color:#8eb7ff}.batch-zoom-card.cleaned strong{color:#63e3bc}.batch-zoom-card canvas{display:block;width:78px;height:78px;object-fit:cover;border-radius:7px;background:#060b14;image-rendering:auto}
    @media(max-width:900px){.batch-detection{grid-template-columns:1fr}.batch-detect-zooms{justify-content:start}}
    @media(max-width:760px){.batch-row-top{grid-template-columns:1fr}.batch-actions{justify-content:flex-start}.batch-toolbar{align-items:stretch}.batch-name-mode{min-width:0;width:100%}.batch-detect-zooms{grid-template-columns:repeat(2,minmax(0,92px))}}
  `;
  doc.head.appendChild(style);
  return true;
}

if (typeof document !== 'undefined' && mountBatchPanel(document)) import('./batch-ui.js');

export { mountBatchPanel };

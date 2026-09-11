import { batchFileKey, batchOutputName, BATCH_STATUSES, runnableBatchItems, sortBatchFiles, summarizeBatch } from './batch.js';
import {
  BATCH_WORKER_MAX_RETRIES,
  batchWorkerRetryDelayMs,
  shouldRetryBatchWorkerError
} from './batchWorkerReliability.js';
import { buildBatchDetectionView, sameBatchInspectOptions } from './batchPreviewModel.js';

const ids = ['batchInput','chooseBatchBtn','batchQueue','batchSummary','batchCleanAllBtn','batchCancelBtn','batchOutputFolderBtn','batchOutputFolderName','batchNameMode'];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const state = {
  items: [],
  outputDirectory: null,
  running: false,
  cancelled: false,
  activeWorker: null,
  ingesting: false,
  previewAnalyzing: false,
  rerunRequested: false
};

function settingNumber(id, fallback) {
  const value = Number(document.getElementById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}
function settingChecked(id, fallback = false) {
  const element = document.getElementById(id);
  return element ? Boolean(element.checked) : fallback;
}
function processOptions(detection) {
  const position = detection?.position;
  const detectedRegion = position ? { x: position.x, y: position.y, size: position.width } : null;
  return {
    sampleCount: settingNumber('sampleCount', 12),
    minConfidence: settingNumber('minConfidence', 0.12),
    detectedRegion,
    alphaGain: settingNumber('alphaGain', 1),
    adaptiveAlpha: settingChecked('adaptiveAlpha', true),
    temporalStabilize: settingChecked('temporalStabilize', true),
    edgePolish: settingNumber('edgePolish', 0.35),
    forceCleanup: settingChecked('forceCleanup', false),
    lowGate: settingNumber('lowGate', 0.025),
    bitrate: settingNumber('bitrate', 12) * 1_000_000
  };
}
function inspectOptions() {
  return {
    sampleCount: settingNumber('sampleCount', 12),
    minConfidence: settingNumber('minConfidence', 0.12),
    edgePolish: settingNumber('edgePolish', 0.35),
    scanFraction: 1
  };
}

function makeItem(file) {
  return {
    key: batchFileKey(file),
    file,
    status: BATCH_STATUSES.QUEUED,
    progress: 0,
    phase: 'Waiting',
    error: '',
    detection: null,
    preview: null,
    inspectOptions: null,
    autoDetectStatus: 'pending',
    autoDetectProgress: 0,
    autoDetectError: '',
    outputUrl: null,
    outputName: batchOutputName(file.name, els.batchNameMode?.value || 'cleaned')
  };
}
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function addFilesDeferred(files) {
  // FileList ordering varies by picker/browser. Normalize it once so preview,
  // Clean all, progress and downloads all follow human scene order (scene1,
  // scene2, ... scene10) instead of the OS selection order.
  const selected = sortBatchFiles(files);
  if (!selected.length || state.running || state.ingesting || state.previewAnalyzing) return;
  state.ingesting = true;
  render();
  const existing = new Set(state.items.map((item) => item.key));
  const chunkSize = 24;
  const added = [];
  try {
    for (let offset = 0; offset < selected.length; offset += chunkSize) {
      const chunk = selected.slice(offset, offset + chunkSize);
      for (const file of chunk) {
        const key = batchFileKey(file);
        if (!existing.has(key)) {
          const item = makeItem(file);
          state.items.push(item);
          added.push(item);
          existing.add(key);
        }
      }
      // Also keep a stable natural order when a user adds another selection to
      // an existing queue.
      state.items.sort((a, b) => sortBatchFiles([a.file, b.file])[0] === a.file ? -1 : 1);
      if (els.batchSummary) els.batchSummary.textContent = `Adding files… ${Math.min(offset + chunk.length, selected.length)}/${selected.length}`;
      await nextFrame();
    }
  } finally {
    state.ingesting = false;
    render();
  }
  if (added.length) setTimeout(() => analyzeBatchPreviews(added.sort((a, b) => sortBatchFiles([a.file, b.file])[0] === a.file ? -1 : 1)), 0);
}
function removeItem(key) {
  if (state.running || state.ingesting || state.previewAnalyzing) return;
  const index = state.items.findIndex((item) => item.key === key);
  if (index < 0) return;
  if (state.items[index].outputUrl) URL.revokeObjectURL(state.items[index].outputUrl);
  state.items.splice(index, 1);
  render();
}
function retryItem(key) {
  const item = state.items.find((entry) => entry.key === key);
  if (!item || state.ingesting || state.previewAnalyzing) return;
  if (item.status !== BATCH_STATUSES.ERROR && item.status !== BATCH_STATUSES.CANCELLED) return;
  item.status = BATCH_STATUSES.QUEUED;
  item.progress = 0;
  item.phase = state.running ? 'Retry queued' : 'Waiting';
  item.error = '';
  state.cancelled = false;
  if (state.running) {
    state.rerunRequested = true;
    render();
    return;
  }
  render();
  setTimeout(() => runBatch(), 0);
}

function statusLabel(item) {
  if (item.status === BATCH_STATUSES.PROCESSING) return `${item.phase} ${Math.round(item.progress * 100)}%`;
  if (item.status === BATCH_STATUSES.SAVED) return 'Saved';
  if (item.status === BATCH_STATUSES.DONE) return 'Ready to download';
  if (item.status === BATCH_STATUSES.ERROR) return `Error: ${item.error || 'Processing failed'}`;
  if (item.status === BATCH_STATUSES.CANCELLED) return 'Cancelled';
  if (item.phase === 'Retry queued') return 'Retry queued';
  return 'Waiting';
}
function drawRoi(canvas, roi) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || !roi?.data || !roi.width || !roi.height) return;
  canvas.width = roi.width;
  canvas.height = roi.height;
  const pixels = roi.data instanceof Uint8ClampedArray ? roi.data : new Uint8ClampedArray(roi.data);
  const image = typeof ImageData !== 'undefined' ? new ImageData(new Uint8ClampedArray(pixels), roi.width, roi.height) : null;
  if (image) ctx.putImageData(image, 0, 0);
  else {
    const fallback = ctx.createImageData(roi.width, roi.height);
    fallback.data.set(pixels);
    ctx.putImageData(fallback, 0, 0);
  }
}
function appendDetectionPreview(row, item) {
  const panel = document.createElement('div');
  panel.className = `batch-detection batch-detection-${item.autoDetectStatus}`;
  if (item.autoDetectStatus === 'pending') {
    panel.innerHTML = '<div class="batch-detect-title">Auto-detect pending</div><div class="muted">Waiting for automatic analysis.</div>';
    row.appendChild(panel);
    return;
  }
  if (item.autoDetectStatus === 'analyzing') {
    panel.innerHTML = `<div class="batch-detect-title">Auto-detecting Gemini watermark…</div><div class="muted">${Math.round(item.autoDetectProgress * 100)}% · ${item.autoDetectError || 'Sampling and scoring frames'}</div>`;
    row.appendChild(panel);
    return;
  }
  if (item.autoDetectStatus === 'error') {
    panel.innerHTML = '<div class="batch-detect-title">Auto-detect preview unavailable</div>';
    const error = document.createElement('div'); error.className = 'muted'; error.textContent = item.autoDetectError || 'Analysis failed; Clean all will retry detection.'; panel.appendChild(error);
    row.appendChild(panel);
    return;
  }

  const view = buildBatchDetectionView(item.detection, item.preview);
  const summary = document.createElement('div'); summary.className = 'batch-detect-summary';
  const title = document.createElement('div'); title.className = 'batch-detect-title'; title.textContent = view.title;
  const note = document.createElement('div'); note.className = 'muted'; note.textContent = view.note;
  const meta = document.createElement('div'); meta.className = 'batch-detect-meta';
  const roiText = view.position ? `ROI ${view.position.x},${view.position.y} · ${view.position.width}×${view.position.height}` : 'ROI unavailable';
  meta.textContent = `${roiText} · Risk flags: ${view.riskFlags}`;
  summary.append(title, note, meta);

  const zooms = document.createElement('div'); zooms.className = 'batch-detect-zooms';
  const originalCard = document.createElement('div'); originalCard.className = 'batch-zoom-card'; originalCard.innerHTML = '<strong>ZOOMED ORIGINAL</strong><canvas></canvas>';
  const cleanedCard = document.createElement('div'); cleanedCard.className = 'batch-zoom-card cleaned'; cleanedCard.innerHTML = '<strong>ZOOMED CLEANED</strong><canvas></canvas>';
  zooms.append(originalCard, cleanedCard);
  panel.append(summary, zooms);
  row.appendChild(panel);
  drawRoi(originalCard.querySelector('canvas'), item.preview?.original);
  drawRoi(cleanedCard.querySelector('canvas'), item.preview?.cleaned);
}
function render() {
  if (!els.batchQueue) return;
  const summary = summarizeBatch(state.items);
  const analyzed = state.items.filter((item) => item.autoDetectStatus === 'ready').length;
  if (!state.ingesting) {
    const detectText = state.previewAnalyzing ? ` · auto-detect ${analyzed}/${summary.total}` : '';
    els.batchSummary.textContent = `${summary.total} file(s) · ${summary.finished} finished · ${summary.error} error(s)${detectText}`;
  }
  els.batchCleanAllBtn.disabled = state.running || state.ingesting || state.previewAnalyzing || runnableBatchItems(state.items).length === 0;
  els.batchCancelBtn.disabled = !state.running && !state.previewAnalyzing;
  els.chooseBatchBtn.disabled = state.running || state.ingesting || state.previewAnalyzing;
  els.batchOutputFolderBtn.disabled = state.running || state.ingesting || state.previewAnalyzing;
  els.batchQueue.innerHTML = '';
  for (const item of state.items) {
    const row = document.createElement('div'); row.className = `batch-row status-${item.status}`;
    const top = document.createElement('div'); top.className = 'batch-row-top';
    const name = document.createElement('div'); name.className = 'batch-name'; name.innerHTML = '<strong></strong><span></span>'; name.querySelector('strong').textContent = item.file.name; name.querySelector('span').textContent = `${(item.file.size / 1024 / 1024).toFixed(1)} MB`;
    const progress = document.createElement('div'); progress.className = 'batch-progress'; progress.innerHTML = '<div class="batch-progress-track"><i></i></div><span></span>'; progress.querySelector('i').style.width = `${Math.round(item.progress * 100)}%`; progress.querySelector('span').textContent = statusLabel(item);
    const actions = document.createElement('div'); actions.className = 'batch-actions';
    if (item.outputUrl && item.status === BATCH_STATUSES.DONE) { const a = document.createElement('a'); a.className = 'button secondary'; a.href = item.outputUrl; a.download = item.outputName; a.textContent = 'Download'; actions.appendChild(a); }
    if (item.status === BATCH_STATUSES.ERROR || item.status === BATCH_STATUSES.CANCELLED) { const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Retry'; retry.onclick = () => retryItem(item.key); actions.appendChild(retry); }
    if (!state.running && !state.ingesting && !state.previewAnalyzing) { const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove'; remove.onclick = () => removeItem(item.key); actions.appendChild(remove); }
    top.append(name, progress, actions);
    row.appendChild(top);
    appendDetectionPreview(row, item);
    els.batchQueue.appendChild(row);
  }
}

async function pickOutputFolder() {
  if (!window.showDirectoryPicker || state.running || state.ingesting || state.previewAnalyzing) return;
  try {
    state.outputDirectory = await window.showDirectoryPicker({ mode: 'readwrite' });
    els.batchOutputFolderName.textContent = state.outputDirectory?.name || 'Selected folder';
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  }
}

function revokeItemOutput(item) {
  if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
  item.outputUrl = null;
}

async function analyzeBatchItem(item, options, { preview = true } = {}) {
  const worker = new Worker(new URL('./video/worker.js', import.meta.url), { type: 'module' });
  state.activeWorker = worker;
  let settled = false;
  try {
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'inspect-progress') {
          item.autoDetectProgress = Number(data.progress) || 0;
          item.autoDetectError = data.phase || '';
          render();
          return;
        }
        if (data.type === 'inspect-result') { settled = true; resolve(data); return; }
        if (data.type === 'error') { settled = true; reject(new Error(data.message || 'Inspection failed')); }
      };
      worker.onerror = (event) => { if (!settled) reject(new Error(event.message || 'Inspection worker failed')); };
      worker.postMessage({ type: 'inspect', file: item.file, options, preview });
    });
    return result;
  } finally {
    worker.terminate();
    if (state.activeWorker === worker) state.activeWorker = null;
  }
}

async function analyzeBatchPreviews(items = state.items) {
  if (state.running || state.ingesting || state.previewAnalyzing || !items.length) return;
  state.previewAnalyzing = true;
  state.cancelled = false;
  render();
  try {
    const options = inspectOptions();
    for (const item of items) {
      if (state.cancelled) break;
      item.autoDetectStatus = 'analyzing';
      item.autoDetectProgress = 0;
      item.autoDetectError = '';
      render();
      try {
        const result = await analyzeBatchItem(item, options, { preview: true });
        item.detection = result.detection || null;
        item.preview = result.preview || null;
        item.inspectOptions = { ...options };
        item.autoDetectStatus = 'ready';
        item.autoDetectProgress = 1;
        item.autoDetectError = '';
      } catch (error) {
        if (state.cancelled) break;
        item.autoDetectStatus = 'error';
        item.autoDetectError = error?.message || 'Auto-detect preview failed';
      }
      render();
      await nextFrame();
    }
  } finally {
    if (state.cancelled) {
      for (const item of items) {
        if (item.autoDetectStatus === 'analyzing') {
          item.autoDetectStatus = 'pending';
          item.autoDetectProgress = 0;
          item.autoDetectError = '';
        }
      }
    }
    state.previewAnalyzing = false;
    state.activeWorker = null;
    render();
  }
}

async function ensureDetection(item) {
  const options = inspectOptions();
  if (item.detection && item.autoDetectStatus === 'ready' && sameBatchInspectOptions(item.inspectOptions, options)) return item.detection;
  item.phase = 'Detecting'; item.progress = 0; render();
  const result = await analyzeBatchItem(item, options, { preview: false });
  item.detection = result.detection || null;
  item.preview = result.preview || item.preview;
  item.inspectOptions = { ...options };
  item.autoDetectStatus = 'ready';
  item.autoDetectProgress = 1;
  return item.detection;
}

async function saveOutput(item, blob) {
  revokeItemOutput(item);
  item.outputName = batchOutputName(item.file.name, els.batchNameMode?.value || 'cleaned');
  if (state.outputDirectory) {
    const handle = await state.outputDirectory.getFileHandle(item.outputName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    item.status = BATCH_STATUSES.SAVED;
  } else {
    item.outputUrl = URL.createObjectURL(blob);
    item.status = BATCH_STATUSES.DONE;
  }
}

async function processBatchItem(item) {
  item.status = BATCH_STATUSES.PROCESSING;
  item.error = '';
  item.progress = 0;
  item.phase = 'Preparing';
  render();
  const detection = await ensureDetection(item);
  if (!detection?.position) throw new Error(detection?.blockedReason || detection?.reason || 'Watermark not detected');
  const options = processOptions(detection);
  const maxAttempts = BATCH_WORKER_MAX_RETRIES + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (state.cancelled) throw new DOMException('Cancelled', 'AbortError');
    const worker = new Worker(new URL('./video/worker.js', import.meta.url), { type: 'module' });
    state.activeWorker = worker;
    try {
      const blob = await new Promise((resolve, reject) => {
        let settled = false;
        worker.onmessage = (event) => {
          const data = event.data || {};
          if (data.type === 'progress') {
            item.progress = Number(data.progress) || 0;
            item.phase = data.phase || 'Processing';
            render();
            return;
          }
          if (data.type === 'result') { settled = true; resolve(data.blob); return; }
          if (data.type === 'error') { settled = true; reject(new Error(data.message || 'Processing failed')); }
        };
        worker.onerror = (event) => { if (!settled) reject(new Error(event.message || 'Worker failed')); };
        worker.postMessage({ type: 'process', file: item.file, options });
      });
      await saveOutput(item, blob);
      item.progress = 1;
      item.phase = item.status === BATCH_STATUSES.SAVED ? 'Saved' : 'Ready';
      render();
      return;
    } catch (error) {
      const retryable = shouldRetryBatchWorkerError(error) && attempt < maxAttempts && !state.cancelled;
      if (!retryable) throw error;
      item.phase = `Worker retry ${attempt}/${BATCH_WORKER_MAX_RETRIES}`;
      render();
      await wait(batchWorkerRetryDelayMs(attempt));
    } finally {
      worker.terminate();
      if (state.activeWorker === worker) state.activeWorker = null;
    }
  }
}

async function runBatch() {
  if (state.running || state.ingesting || state.previewAnalyzing) return;
  state.running = true;
  state.cancelled = false;
  state.rerunRequested = false;
  render();
  try {
    for (const item of runnableBatchItems(state.items)) {
      if (state.cancelled) break;
      try {
        await processBatchItem(item);
      } catch (error) {
        if (state.cancelled || error?.name === 'AbortError') {
          item.status = BATCH_STATUSES.CANCELLED;
          item.phase = 'Cancelled';
        } else {
          item.status = BATCH_STATUSES.ERROR;
          item.error = error?.message || 'Processing failed';
          item.phase = 'Error';
        }
        render();
      }
    }
  } finally {
    state.running = false;
    state.activeWorker = null;
    render();
    if (!state.cancelled && state.rerunRequested && runnableBatchItems(state.items).length) setTimeout(() => runBatch(), 0);
  }
}

function cancelBatch() {
  if (!state.running && !state.previewAnalyzing) return;
  state.cancelled = true;
  state.activeWorker?.terminate?.();
  state.activeWorker = null;
  for (const item of state.items) {
    if (item.status === BATCH_STATUSES.PROCESSING) {
      item.status = BATCH_STATUSES.CANCELLED;
      item.phase = 'Cancelled';
    }
  }
  render();
}

els.chooseBatchBtn?.addEventListener('click', () => els.batchInput?.click());
els.batchInput?.addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  setTimeout(() => addFilesDeferred(files), 0);
});
els.batchCleanAllBtn?.addEventListener('click', runBatch);
els.batchCancelBtn?.addEventListener('click', cancelBatch);
els.batchOutputFolderBtn?.addEventListener('click', pickOutputFolder);
els.batchNameMode?.addEventListener('change', () => {
  for (const item of state.items) item.outputName = batchOutputName(item.file.name, els.batchNameMode?.value || 'cleaned');
  render();
});

render();

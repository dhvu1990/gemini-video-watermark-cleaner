import { batchFileKey, batchOutputName, BATCH_STATUSES, runnableBatchItems, summarizeBatch } from './batch.js';

const ids = ['batchInput','chooseBatchBtn','batchQueue','batchSummary','batchCleanAllBtn','batchCancelBtn','batchOutputFolderBtn','batchOutputFolderName','batchNameMode'];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const state = { items: [], outputDirectory: null, running: false, cancelled: false, activeWorker: null };

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
  return { key: batchFileKey(file), file, status: BATCH_STATUSES.QUEUED, progress: 0, phase: 'Waiting', error: '', detection: null, outputUrl: null, outputName: batchOutputName(file.name, els.batchNameMode?.value || 'cleaned') };
}
function addFiles(files) {
  const existing = new Set(state.items.map((item) => item.key));
  for (const file of Array.from(files || [])) {
    const key = batchFileKey(file);
    if (!existing.has(key)) { state.items.push(makeItem(file)); existing.add(key); }
  }
  render();
}
function removeItem(key) {
  if (state.running) return;
  const index = state.items.findIndex((item) => item.key === key);
  if (index < 0) return;
  if (state.items[index].outputUrl) URL.revokeObjectURL(state.items[index].outputUrl);
  state.items.splice(index, 1);
  render();
}
function retryItem(key) {
  const item = state.items.find((entry) => entry.key === key);
  if (!item || state.running) return;
  item.status = BATCH_STATUSES.QUEUED; item.progress = 0; item.phase = 'Waiting'; item.error = '';
  render();
}

function statusLabel(item) {
  if (item.status === BATCH_STATUSES.PROCESSING) return `${item.phase} ${Math.round(item.progress * 100)}%`;
  if (item.status === BATCH_STATUSES.SAVED) return 'Saved';
  if (item.status === BATCH_STATUSES.DONE) return 'Ready to download';
  if (item.status === BATCH_STATUSES.ERROR) return `Error: ${item.error || 'Processing failed'}`;
  if (item.status === BATCH_STATUSES.CANCELLED) return 'Cancelled';
  return 'Waiting';
}
function render() {
  if (!els.batchQueue) return;
  const summary = summarizeBatch(state.items);
  els.batchSummary.textContent = `${summary.total} file(s) · ${summary.finished} finished · ${summary.error} error(s)`;
  els.batchCleanAllBtn.disabled = state.running || runnableBatchItems(state.items).length === 0;
  els.batchCancelBtn.disabled = !state.running;
  els.chooseBatchBtn.disabled = state.running;
  els.batchOutputFolderBtn.disabled = state.running;
  els.batchQueue.innerHTML = '';
  for (const item of state.items) {
    const row = document.createElement('div'); row.className = `batch-row status-${item.status}`;
    const name = document.createElement('div'); name.className = 'batch-name'; name.innerHTML = `<strong></strong><span></span>`; name.querySelector('strong').textContent = item.file.name; name.querySelector('span').textContent = `${(item.file.size / 1024 / 1024).toFixed(1)} MB`;
    const progress = document.createElement('div'); progress.className = 'batch-progress'; progress.innerHTML = `<div class="batch-progress-track"><i></i></div><span></span>`; progress.querySelector('i').style.width = `${Math.round(item.progress * 100)}%`; progress.querySelector('span').textContent = statusLabel(item);
    const actions = document.createElement('div'); actions.className = 'batch-actions';
    if (item.outputUrl && item.status === BATCH_STATUSES.DONE) { const a = document.createElement('a'); a.className = 'button secondary'; a.href = item.outputUrl; a.download = item.outputName; a.textContent = 'Download'; actions.appendChild(a); }
    if (item.status === BATCH_STATUSES.ERROR || item.status === BATCH_STATUSES.CANCELLED) { const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Retry'; retry.onclick = () => retryItem(item.key); actions.appendChild(retry); }
    if (!state.running) { const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove'; remove.onclick = () => removeItem(item.key); actions.appendChild(remove); }
    row.append(name, progress, actions); els.batchQueue.appendChild(row);
  }
}

function runWorker(type, file, options, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./video/worker.js', import.meta.url), { type: 'module' });
    state.activeWorker = worker;
    const tag = `batch:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.tag !== tag) return;
      if (message.type === 'progress') { onProgress?.(message); return; }
      if (message.type === 'inspect-result' || message.type === 'process-result') { worker.terminate(); if (state.activeWorker === worker) state.activeWorker = null; resolve(message); }
      else if (message.type === 'cancelled') { worker.terminate(); if (state.activeWorker === worker) state.activeWorker = null; reject(new DOMException('Cancelled', 'AbortError')); }
      else if (message.type === 'error') { worker.terminate(); if (state.activeWorker === worker) state.activeWorker = null; reject(new Error(message.error || 'Worker failed')); }
    };
    worker.onerror = (event) => { worker.terminate(); if (state.activeWorker === worker) state.activeWorker = null; reject(new Error(event.message || 'Worker failed')); };
    worker.postMessage({ type, tag, file, options });
  });
}

async function saveBlob(item, blob) {
  item.outputName = batchOutputName(item.file.name, els.batchNameMode?.value || 'cleaned');
  if (state.outputDirectory) {
    const handle = await state.outputDirectory.getFileHandle(item.outputName, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(blob); } finally { await writable.close(); }
    item.status = BATCH_STATUSES.SAVED;
  } else {
    if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    item.outputUrl = URL.createObjectURL(blob);
    item.status = BATCH_STATUSES.DONE;
  }
}

async function processOne(item) {
  item.status = BATCH_STATUSES.PROCESSING; item.phase = 'Detecting'; item.progress = 0.01; item.error = ''; render();
  const inspected = await runWorker('inspect', item.file, inspectOptions(), (message) => { item.phase = message.status || 'Detecting'; item.progress = Math.min(0.28, 0.28 * (message.progress ?? 0)); render(); });
  item.detection = inspected.result?.detection || null;
  const minConfidence = settingNumber('minConfidence', 0.12);
  if (!item.detection?.detected && !settingChecked('forceCleanup', false)) throw new Error(`Detection confidence ${(item.detection?.confidence ?? 0).toFixed(3)} is below ${minConfidence.toFixed(3)}`);
  item.phase = 'Cleaning'; item.progress = 0.30; render();
  const processed = await runWorker('process', item.file, processOptions(item.detection), (message) => { item.phase = message.status || 'Cleaning'; item.progress = 0.30 + 0.68 * Math.max(0, Math.min(1, message.progress ?? 0)); render(); });
  item.phase = state.outputDirectory ? 'Saving' : 'Ready'; item.progress = 0.99; render();
  await saveBlob(item, new Blob([processed.buffer], { type: 'video/mp4' }));
  item.progress = 1; item.phase = item.status === BATCH_STATUSES.SAVED ? 'Saved' : 'Ready'; render();
}

async function runBatch() {
  if (state.running) return;
  const queue = runnableBatchItems(state.items);
  if (!queue.length) return;
  state.running = true; state.cancelled = false; render();
  for (const item of queue) {
    if (state.cancelled) { if (item.status === BATCH_STATUSES.QUEUED) item.status = BATCH_STATUSES.CANCELLED; continue; }
    try { await processOne(item); }
    catch (error) { item.status = error?.name === 'AbortError' ? BATCH_STATUSES.CANCELLED : BATCH_STATUSES.ERROR; item.error = error?.message || String(error); item.phase = item.status === BATCH_STATUSES.CANCELLED ? 'Cancelled' : 'Error'; render(); }
  }
  state.running = false; state.activeWorker = null; render();
}

async function chooseOutputFolder() {
  if (!window.showDirectoryPicker) { alert('Folder saving requires a Chromium browser with File System Access API support. You can still process the queue and download each result.'); return; }
  try { state.outputDirectory = await window.showDirectoryPicker({ mode: 'readwrite' }); els.batchOutputFolderName.textContent = state.outputDirectory.name || 'Selected folder'; }
  catch (error) { if (error?.name !== 'AbortError') alert(error?.message || 'Could not open output folder'); }
}

els.chooseBatchBtn?.addEventListener('click', () => { if (!state.running) { els.batchInput.value = ''; els.batchInput.click(); } });
els.batchInput?.addEventListener('change', () => addFiles(els.batchInput.files));
els.batchCleanAllBtn?.addEventListener('click', runBatch);
els.batchCancelBtn?.addEventListener('click', () => { state.cancelled = true; state.activeWorker?.postMessage({ type: 'cancel' }); });
els.batchOutputFolderBtn?.addEventListener('click', chooseOutputFolder);
els.batchNameMode?.addEventListener('change', () => { for (const item of state.items) item.outputName = batchOutputName(item.file.name, els.batchNameMode.value); render(); });
window.addEventListener('beforeunload', () => { for (const item of state.items) if (item.outputUrl) URL.revokeObjectURL(item.outputUrl); state.activeWorker?.terminate(); });
render();

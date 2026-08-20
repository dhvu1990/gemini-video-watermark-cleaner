import { batchFileKey, batchOutputName, BATCH_STATUSES, runnableBatchItems, summarizeBatch } from './batch.js';
import {
  BATCH_WORKER_MAX_RETRIES,
  batchWorkerRetryDelayMs,
  shouldRetryBatchWorkerError
} from './batchWorkerReliability.js';

const ids = ['batchInput','chooseBatchBtn','batchQueue','batchSummary','batchCleanAllBtn','batchCancelBtn','batchOutputFolderBtn','batchOutputFolderName','batchNameMode'];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const state = {
  items: [],
  outputDirectory: null,
  running: false,
  cancelled: false,
  activeWorker: null,
  ingesting: false,
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
  const selected = Array.from(files || []);
  if (!selected.length || state.running || state.ingesting) return;
  state.ingesting = true;
  render();
  const existing = new Set(state.items.map((item) => item.key));
  const chunkSize = 24;
  try {
    for (let offset = 0; offset < selected.length; offset += chunkSize) {
      const chunk = selected.slice(offset, offset + chunkSize);
      for (const file of chunk) {
        const key = batchFileKey(file);
        if (!existing.has(key)) { state.items.push(makeItem(file)); existing.add(key); }
      }
      if (els.batchSummary) els.batchSummary.textContent = `Adding files… ${Math.min(offset + chunk.length, selected.length)}/${selected.length}`;
      await nextFrame();
    }
  } finally {
    state.ingesting = false;
    render();
  }
}
function removeItem(key) {
  if (state.running || state.ingesting) return;
  const index = state.items.findIndex((item) => item.key === key);
  if (index < 0) return;
  if (state.items[index].outputUrl) URL.revokeObjectURL(state.items[index].outputUrl);
  state.items.splice(index, 1);
  render();
}
function retryItem(key) {
  const item = state.items.find((entry) => entry.key === key);
  if (!item || state.ingesting) return;
  if (item.status !== BATCH_STATUSES.ERROR && item.status !== BATCH_STATUSES.CANCELLED) return;
  item.status = BATCH_STATUSES.QUEUED;
  item.progress = 0;
  item.phase = state.running ? 'Retry queued' : 'Waiting';
  item.error = '';
  item.detection = null;
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
function render() {
  if (!els.batchQueue) return;
  const summary = summarizeBatch(state.items);
  if (!state.ingesting) els.batchSummary.textContent = `${summary.total} file(s) · ${summary.finished} finished · ${summary.error} error(s)`;
  els.batchCleanAllBtn.disabled = state.running || state.ingesting || runnableBatchItems(state.items).length === 0;
  els.batchCancelBtn.disabled = !state.running;
  els.chooseBatchBtn.disabled = state.running || state.ingesting;
  els.batchOutputFolderBtn.disabled = state.running || state.ingesting;
  els.batchQueue.innerHTML = '';
  for (const item of state.items) {
    const row = document.createElement('div'); row.className = `batch-row status-${item.status}`;
    const name = document.createElement('div'); name.className = 'batch-name'; name.innerHTML = `<strong></strong><span></span>`; name.querySelector('strong').textContent = item.file.name; name.querySelector('span').textContent = `${(item.file.size / 1024 / 1024).toFixed(1)} MB`;
    const progress = document.createElement('div'); progress.className = 'batch-progress'; progress.innerHTML = `<div class="batch-progress-track"><i></i></div><span></span>`; progress.querySelector('i').style.width = `${Math.round(item.progress * 100)}%`; progress.querySelector('span').textContent = statusLabel(item);
    const actions = document.createElement('div'); actions.className = 'batch-actions';
    if (item.outputUrl && item.status === BATCH_STATUSES.DONE) { const a = document.createElement('a'); a.className = 'button secondary'; a.href = item.outputUrl; a.download = item.outputName; a.textContent = 'Download'; actions.appendChild(a); }
    if (item.status === BATCH_STATUSES.ERROR || item.status === BATCH_STATUSES.CANCELLED) { const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Retry'; retry.onclick = () => retryItem(item.key); actions.appendChild(retry); }
    if (!state.running && !state.ingesting) { const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove'; remove.onclick = () => removeItem(item.key); actions.appendChild(remove); }
    row.append(name, progress, actions); els.batchQueue.appendChild(row);
  }
}

function disposeBatchWorker(worker = state.activeWorker) {
  if (!worker) return;
  try { worker.terminate(); } catch {}
  if (state.activeWorker === worker) state.activeWorker = null;
}
function getBatchWorker() {
  if (state.activeWorker) return state.activeWorker;
  const worker = new Worker(new URL('./video/worker.js', import.meta.url), { type: 'module' });
  state.activeWorker = worker;
  return worker;
}
function workerTransportError(message) {
  const error = new Error(message || 'Worker transport failed');
  error.code = 'BATCH_WORKER_TRANSPORT';
  return error;
}
function runWorkerOnce(type, file, options, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = getBatchWorker();
    const tag = `batch:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (event) => {
      const message = event.data || {};
      if (message.tag !== tag) return;
      if (message.type === 'progress') { onProgress?.(message); return; }
      if (message.type === 'inspect-result' || message.type === 'process-result') finishResolve(message);
      else if (message.type === 'cancelled') finishReject(new DOMException('Cancelled', 'AbortError'));
      else if (message.type === 'error') finishReject(new Error(message.error || 'Worker failed'));
    };
    const onError = (event) => {
      disposeBatchWorker(worker);
      finishReject(workerTransportError(event?.message || 'Worker network/module error'));
    };
    const onMessageError = () => {
      disposeBatchWorker(worker);
      finishReject(workerTransportError('Worker message transport error'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    try { worker.postMessage({ type, tag, file, options }); }
    catch (error) { disposeBatchWorker(worker); finishReject(error); }
  });
}
async function runWorker(type, file, options, onProgress) {
  let retriesUsed = 0;
  while (true) {
    try {
      return await runWorkerOnce(type, file, options, onProgress);
    } catch (error) {
      if (!shouldRetryBatchWorkerError(error, retriesUsed, BATCH_WORKER_MAX_RETRIES)) throw error;
      retriesUsed += 1;
      disposeBatchWorker();
      onProgress?.({
        status: `Transient network/worker error — reconnecting ${retriesUsed}/${BATCH_WORKER_MAX_RETRIES}`,
        progress: 0
      });
      await wait(batchWorkerRetryDelayMs(retriesUsed));
    }
  }
}

async function saveBlobOnce(item, blob) {
  item.outputName = batchOutputName(item.file.name, els.batchNameMode?.value || 'cleaned');
  if (state.outputDirectory) {
    const handle = await state.outputDirectory.getFileHandle(item.outputName, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(blob); }
    catch (error) {
      try { await writable.abort?.(); } catch {}
      throw error;
    }
    finally { try { await writable.close(); } catch {} }
    item.status = BATCH_STATUSES.SAVED;
  } else {
    if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    item.outputUrl = URL.createObjectURL(blob);
    item.status = BATCH_STATUSES.DONE;
  }
}
async function saveBlob(item, blob) {
  let retriesUsed = 0;
  while (true) {
    try { return await saveBlobOnce(item, blob); }
    catch (error) {
      if (!shouldRetryBatchWorkerError(error, retriesUsed, 1)) throw error;
      retriesUsed += 1;
      item.phase = 'Retrying save';
      render();
      await wait(batchWorkerRetryDelayMs(retriesUsed));
    }
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
  if (state.running || state.ingesting) return;
  const queue = runnableBatchItems(state.items);
  if (!queue.length) return;
  state.running = true;
  state.cancelled = false;
  state.rerunRequested = false;
  render();
  for (const item of queue) {
    if (state.cancelled) { if (item.status === BATCH_STATUSES.QUEUED) item.status = BATCH_STATUSES.CANCELLED; continue; }
    try { await processOne(item); }
    catch (error) {
      item.status = error?.name === 'AbortError' ? BATCH_STATUSES.CANCELLED : BATCH_STATUSES.ERROR;
      item.error = error?.message || String(error);
      item.phase = item.status === BATCH_STATUSES.CANCELLED ? 'Cancelled' : 'Error';
      render();
    }
    if (state.rerunRequested && !state.cancelled) break;
  }
  const resumeQueuedRetry = state.rerunRequested && !state.cancelled;
  state.running = false;
  state.rerunRequested = false;
  render();
  if (resumeQueuedRetry) setTimeout(() => runBatch(), 0);
}

async function chooseOutputFolder() {
  if (!window.showDirectoryPicker) { alert('Folder saving requires a Chromium browser with File System Access API support. You can still process the queue and download each result.'); return; }
  try { state.outputDirectory = await window.showDirectoryPicker({ mode: 'readwrite' }); els.batchOutputFolderName.textContent = state.outputDirectory.name || 'Selected folder'; }
  catch (error) { if (error?.name !== 'AbortError') alert(error?.message || 'Could not open output folder'); }
}

els.chooseBatchBtn?.addEventListener('click', () => { if (!state.running && !state.ingesting) { els.batchInput.value = ''; els.batchInput.click(); } });
els.batchInput?.addEventListener('change', () => {
  const selected = Array.from(els.batchInput.files || []);
  els.batchInput.value = '';
  if (!selected.length) return;
  setTimeout(() => addFilesDeferred(selected), 0);
});
els.batchCleanAllBtn?.addEventListener('click', runBatch);
els.batchCancelBtn?.addEventListener('click', () => {
  state.cancelled = true;
  state.rerunRequested = false;
  state.activeWorker?.postMessage({ type: 'cancel' });
});
els.batchOutputFolderBtn?.addEventListener('click', chooseOutputFolder);
els.batchNameMode?.addEventListener('change', () => { for (const item of state.items) item.outputName = batchOutputName(item.file.name, els.batchNameMode.value); render(); });
window.addEventListener('beforeunload', () => {
  for (const item of state.items) if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
  disposeBatchWorker();
});
render();

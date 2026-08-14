import { formatFileSize, validateVideoFile } from './video/file.js';

const els = Object.fromEntries([
  'fileInput','chooseFileBtn','dropZone','fileInfo','sampleCount','minConfidence','analyzeBtn','detectResult',
  'manualMode','wmX','wmY','wmSize','alphaGain','edgePolish','adaptiveAlpha','temporalStabilize',
  'forceCleanup','bitrate','lowGate','cleanBtn','cancelBtn','downloadBtn','progressBar','status'
].map((id) => [id, document.getElementById(id)]));

let file = null;
let worker = null;
let detection = null;
let outputUrl = null;
let busy = false;

function setBusy(value) {
  busy = value;
  els.analyzeBtn.disabled = !file || value;
  els.cleanBtn.disabled = !file || value;
  els.cancelBtn.disabled = !value;
  els.chooseFileBtn.disabled = value;
}

function setStatus(text, progress = null) {
  els.status.textContent = text;
  if (progress !== null) els.progressBar.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
}

function setFileMessage(text, isError = false) {
  els.fileInfo.textContent = text;
  els.fileInfo.classList.toggle('error', isError);
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./video/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (event) => {
    setBusy(false);
    setStatus(`Worker error: ${event.message}`);
  };
  return worker;
}

function handleWorkerMessage(event) {
  const message = event.data || {};
  if (message.type === 'progress') {
    setStatus(message.status || message.phase || 'Processing...', message.progress ?? null);
    return;
  }
  if (message.type === 'inspect-result') {
    detection = message.result;
    const d = message.result?.detection;
    const meta = message.result?.metadata;
    if (d?.position) {
      els.wmX.value = d.position.x;
      els.wmY.value = d.position.y;
      els.wmSize.value = d.position.width;
      if (Number.isFinite(d.alphaGain)) els.alphaGain.value = d.alphaGain.toFixed(3);
    }
    els.detectResult.textContent = JSON.stringify({ metadata: meta, detection: d }, null, 2);
    setBusy(false);
    setStatus(d?.detected ? `Detected: ${d.candidateId} confidence ${d.confidence.toFixed(3)}` : 'No high-confidence watermark detected.', 1);
    return;
  }
  if (message.type === 'process-result') {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    const blob = new Blob([message.buffer], { type: 'video/mp4' });
    outputUrl = URL.createObjectURL(blob);
    els.downloadBtn.href = outputUrl;
    els.downloadBtn.download = `${file.name.replace(/\.[^.]+$/, '')}-cleaned.mp4`;
    els.downloadBtn.classList.remove('disabled');
    els.downloadBtn.setAttribute('aria-disabled', 'false');
    setBusy(false);
    setStatus(`Done. ${message.meta?.processedFrames ?? ''} frames processed; ${message.meta?.skippedFrames ?? 0} skipped.`, 1);
    return;
  }
  if (message.type === 'cancelled') {
    setBusy(false);
    setStatus('Cancelled.');
    return;
  }
  if (message.type === 'error') {
    setBusy(false);
    setStatus(message.error || 'Processing failed.');
  }
}

function clearSelectedFile(reason = 'No video selected.') {
  file = null;
  detection = null;
  setFileMessage(reason, reason !== 'No video selected.');
  els.detectResult.textContent = 'Waiting for video...';
  els.downloadBtn.classList.add('disabled');
  els.downloadBtn.setAttribute('aria-disabled', 'true');
  setBusy(false);
}

function useFile(nextFile) {
  if (!nextFile) return;

  const validation = validateVideoFile(nextFile);
  if (!validation.ok) {
    clearSelectedFile(validation.reason);
    setStatus(validation.reason, 0);
    return;
  }

  file = nextFile;
  detection = null;
  setFileMessage(`${file.name} - ${formatFileSize(file.size)} - ${validation.mime}`);
  els.detectResult.textContent = 'Video loaded. Run analysis for multi-frame detection.';
  els.downloadBtn.classList.add('disabled');
  els.downloadBtn.setAttribute('aria-disabled', 'true');
  setBusy(false);
  setStatus('Video loaded. Click Analyze watermark.', 0);
}

els.chooseFileBtn.addEventListener('click', () => {
  if (busy) return;
  els.fileInput.value = '';
  els.fileInput.click();
});

els.fileInput.addEventListener('change', () => {
  const selected = els.fileInput.files?.[0];
  if (selected) useFile(selected);
});

for (const type of ['dragenter', 'dragover']) {
  els.dropZone.addEventListener(type, (event) => { event.preventDefault(); els.dropZone.classList.add('drag'); });
}
for (const type of ['dragleave', 'drop']) {
  els.dropZone.addEventListener(type, (event) => { event.preventDefault(); els.dropZone.classList.remove('drag'); });
}
els.dropZone.addEventListener('drop', (event) => useFile(event.dataTransfer?.files?.[0]));

els.analyzeBtn.addEventListener('click', () => {
  if (!file || busy) return;
  setBusy(true);
  setStatus('Sampling video frames...', 0.01);
  ensureWorker().postMessage({
    type: 'inspect',
    file,
    options: {
      sampleCount: Number(els.sampleCount.value),
      minConfidence: Number(els.minConfidence.value)
    }
  });
});

els.cleanBtn.addEventListener('click', () => {
  if (!file || busy) return;
  setBusy(true);
  setStatus('Starting export...', 0.01);
  ensureWorker().postMessage({
    type: 'process',
    file,
    options: {
      sampleCount: Number(els.sampleCount.value),
      minConfidence: Number(els.minConfidence.value),
      manual: els.manualMode.checked ? {
        x: Number(els.wmX.value),
        y: Number(els.wmY.value),
        size: Number(els.wmSize.value)
      } : null,
      alphaGain: Number(els.alphaGain.value),
      adaptiveAlpha: els.adaptiveAlpha.checked,
      temporalStabilize: els.temporalStabilize.checked,
      edgePolish: Number(els.edgePolish.value),
      forceCleanup: els.forceCleanup.checked,
      lowGate: Number(els.lowGate.value),
      bitrate: Number(els.bitrate.value) * 1_000_000
    }
  });
});

els.cancelBtn.addEventListener('click', () => {
  worker?.postMessage({ type: 'cancel' });
  setStatus('Cancelling...');
});

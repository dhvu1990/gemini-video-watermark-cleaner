import { formatFileSize, validateVideoFile } from './video/file.js';
import { QUICK_SAMPLE_COUNT, QUICK_SCAN_FRACTION, shouldAcceptQuickDetection } from './video/analysisPolicy.js';

const els = Object.fromEntries([
  'fileInput','chooseFileBtn','dropZone','fileInfo','sampleCount','minConfidence','analyzeBtn','detectResult',
  'manualMode','wmX','wmY','wmSize','alphaGain','edgePolish','adaptiveAlpha','temporalStabilize',
  'forceCleanup','bitrate','lowGate','cleanBtn','cancelBtn','downloadBtn','progressBar','status',
  'previewPanel','previewStage','previewVideo','watermarkBox','analysisSummary','previewNote','originalZoom','cleanedZoom',
  'resultPanel','resultVideo','resultSummary'
].map((id) => [id, document.getElementById(id)]));

let file = null;
let worker = null;
let detection = null;
let outputUrl = null;
let previewUrl = null;
let busy = false;
let analysisSerial = 0;
let activeTag = null;

function setBusy(value) {
  busy = value;
  els.analyzeBtn.disabled = !file || value;
  els.cleanBtn.disabled = !file || value;
  els.cancelBtn.disabled = !value;
  els.chooseFileBtn.disabled = value;
  const analyzing = value && (String(activeTag || '').startsWith('quick:') || String(activeTag || '').startsWith('full:'));
  els.analyzeBtn.classList.toggle('loading', analyzing);
}
function setStatus(text, progress = null) { els.status.textContent = text; if (progress !== null) els.progressBar.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`; }
function setFileMessage(text, isError = false) { els.fileInfo.textContent = text; els.fileInfo.classList.toggle('error', isError); }
function resetWorker() { if (worker) worker.terminate(); worker = null; activeTag = null; }
function resetOutputPreview({ revoke = true } = {}) {
  if (revoke && outputUrl) URL.revokeObjectURL(outputUrl); outputUrl = null; els.resultVideo.pause(); els.resultVideo.removeAttribute('src'); els.resultVideo.load(); els.resultPanel.classList.add('hidden'); els.resultSummary.textContent = 'The cleaned MP4 will appear here after export completes.'; els.downloadBtn.removeAttribute('href'); els.downloadBtn.classList.add('disabled'); els.downloadBtn.setAttribute('aria-disabled', 'true');
}
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./video/worker.js', import.meta.url), { type: 'module' }); worker.onmessage = handleWorkerMessage;
  worker.onerror = (event) => { setBusy(false); els.analysisSummary.textContent = 'Analysis worker failed'; els.previewNote.textContent = event.message || 'Worker error'; setStatus(`Worker error: ${event.message}`); };
  return worker;
}
function humanizeCandidate(candidateId = '') { return String(candidateId).replace(/@.*$/, '').replace(/^veo-/, '').replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()); }
function drawRoi(canvas, roi) {
  const ctx = canvas.getContext('2d'); if (!ctx || !roi?.data || !roi.width || !roi.height) return; canvas.width = roi.width; canvas.height = roi.height;
  const pixels = roi.data instanceof Uint8ClampedArray ? roi.data : new Uint8ClampedArray(roi.data); const image = typeof ImageData !== 'undefined' ? new ImageData(new Uint8ClampedArray(pixels), roi.width, roi.height) : null;
  if (image) ctx.putImageData(image, 0, 0); else { const fallback = ctx.createImageData(roi.width, roi.height); fallback.data.set(pixels); ctx.putImageData(fallback, 0, 0); }
}
function clearCanvas(canvas) { const ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); }
function updateWatermarkBox(meta, position, uncertain = false) {
  if (!meta?.width || !meta?.height || !position) { els.watermarkBox.classList.add('hidden'); return; }
  els.previewStage.style.aspectRatio = `${meta.width} / ${meta.height}`; els.watermarkBox.style.left = `${position.x / meta.width * 100}%`; els.watermarkBox.style.top = `${position.y / meta.height * 100}%`; els.watermarkBox.style.width = `${position.width / meta.width * 100}%`; els.watermarkBox.style.height = `${position.height / meta.height * 100}%`; els.watermarkBox.classList.toggle('uncertain', uncertain); els.watermarkBox.classList.remove('hidden');
}
function seekPreview(timestamp) {
  if (!Number.isFinite(timestamp)) return; const apply = () => { try { const duration = Number.isFinite(els.previewVideo.duration) ? els.previewVideo.duration : null; els.previewVideo.currentTime = duration ? Math.min(Math.max(0, timestamp), Math.max(0, duration - 0.02)) : Math.max(0, timestamp); } catch {} };
  if (els.previewVideo.readyState >= 1) apply(); else els.previewVideo.addEventListener('loadedmetadata', apply, { once: true });
}
function renderDetection(result, { source = 'full' } = {}) {
  detection = result; const d = result?.detection; const meta = result?.metadata; const preview = result?.preview;
  els.previewPanel.classList.toggle('portrait', Boolean(meta?.height > meta?.width));
  if (d?.position) { els.wmX.value = d.position.x; els.wmY.value = d.position.y; els.wmSize.value = d.position.width; if (Number.isFinite(d.alphaGain)) els.alphaGain.value = d.alphaGain.toFixed(3); }
  const finalCleanup = preview?.edgeBridge ? { before: preview.edgeBridge.finalResidualBefore || null, after: preview.edgeBridge.finalResidualAfter || null, improvement: preview.edgeBridge.finalResidualImprovement ?? null, correctedPixels: preview.edgeBridge.quadrantPixels ?? 0 } : null;
  const adaptiveBackground = preview?.dualRingFinish?.smoothBackground || null;
  els.detectResult.textContent = JSON.stringify({ metadata: meta, detection: d, finalCleanup, adaptiveBackground }, null, 2);
  els.previewPanel.classList.remove('hidden'); if (preview?.original) drawRoi(els.originalZoom, preview.original); if (preview?.cleaned) drawRoi(els.cleanedZoom, preview.cleaned); seekPreview(preview?.timestamp);
  const confidence = Number(d?.confidence) || 0; const match = Math.round(confidence * 100); const label = humanizeCandidate(d?.candidateId || 'Gemini Veo'); if (d?.position) updateWatermarkBox(meta, d.position, !d.detected);
  if (d?.detected) { els.analysisSummary.textContent = `Auto-detected: Gemini Veo — ${label} (${match}% match)`; const bg = adaptiveBackground?.mode === 'smooth-rebuild' ? ' Smooth background rebuild enabled.' : ' Structured-background fallback.'; els.previewNote.textContent = (source === 'quick' ? `Quick scan accepted with ${QUICK_SAMPLE_COUNT} sampled frames.` : 'Full scan confirmed the watermark across multiple frames.') + bg; setStatus(`Detected: ${d.candidateId} confidence ${confidence.toFixed(3)}`, 1); }
  else { els.analysisSummary.textContent = `Possible watermark candidate (${match}% match)`; els.previewNote.textContent = 'Confidence is below the selected threshold. Review the box or use manual override.'; setStatus('No high-confidence watermark detected.', 1); }
}
function postInspect(kind, sampleCount) {
  if (!file) return; const tag = `${kind}:${analysisSerial}`; activeTag = tag; setBusy(true); els.analysisSummary.textContent = kind === 'quick' ? 'Auto-detecting Gemini watermark…' : 'Running full multi-frame scan…'; els.previewNote.textContent = kind === 'quick' ? `Quick scan: ${sampleCount} frames over the first ${Math.round(QUICK_SCAN_FRACTION * 100)}% of the video.` : `Sampling up to ${sampleCount} frames for confirmation.`; setStatus(kind === 'quick' ? 'Quick scanning video…' : 'Sampling full video…', 0.01);
  ensureWorker().postMessage({ type: 'inspect', tag, file, options: { sampleCount, scanFraction: kind === 'quick' ? QUICK_SCAN_FRACTION : 1, minConfidence: Number(els.minConfidence.value), edgePolish: Number(els.edgePolish.value) } });
}
function startAutoAnalysis() { postInspect('quick', QUICK_SAMPLE_COUNT); }
function startFullAnalysis() { postInspect('full', Number(els.sampleCount.value)); }
function handleWorkerMessage(event) {
  const message = event.data || {}; if (message.tag && activeTag && message.tag !== activeTag) return;
  if (message.type === 'progress') { setStatus(message.status || message.phase || 'Processing...', message.progress ?? null); if (String(message.tag || '').startsWith('quick:')) { els.analysisSummary.textContent = 'Auto-detecting Gemini watermark…'; els.previewNote.textContent = message.status || 'Quick scan in progress…'; } else if (String(message.tag || '').startsWith('full:')) { els.analysisSummary.textContent = 'Running full multi-frame scan…'; els.previewNote.textContent = message.status || 'Full scan in progress…'; } return; }
  if (message.type === 'inspect-result') { const d = message.result?.detection; const minConfidence = Number(els.minConfidence.value); const isQuick = String(message.tag || '').startsWith('quick:'); if (isQuick && !shouldAcceptQuickDetection(d, minConfidence)) { els.analysisSummary.textContent = 'Quick scan inconclusive — expanding analysis…'; els.previewNote.textContent = `Quick confidence ${(Number(d?.confidence) || 0).toFixed(3)}. Starting full scan automatically.`; setStatus('Quick scan inconclusive. Running full scan…', 0.6); setTimeout(startFullAnalysis, 30); return; } renderDetection(message.result, { source: isQuick ? 'quick' : 'full' }); setBusy(false); return; }
  if (message.type === 'process-result') { resetOutputPreview(); const blob = new Blob([message.buffer], { type: 'video/mp4' }); outputUrl = URL.createObjectURL(blob); els.downloadBtn.href = outputUrl; els.downloadBtn.download = `${file.name.replace(/\.[^.]+$/, '')}-cleaned.mp4`; els.downloadBtn.classList.remove('disabled'); els.downloadBtn.setAttribute('aria-disabled', 'false'); els.resultVideo.src = outputUrl; els.resultVideo.load(); els.resultPanel.classList.remove('hidden'); const processed = message.meta?.processedFrames ?? ''; const skipped = message.meta?.skippedFrames ?? 0; els.resultSummary.textContent = `${processed} frames processed; ${skipped} skipped. Review the cleaned video here before downloading.`; setBusy(false); setStatus(`Done. ${processed} frames processed; ${skipped} skipped.`, 1); els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (message.type === 'cancelled') { setBusy(false); els.analysisSummary.textContent = 'Analysis cancelled'; setStatus('Cancelled.'); return; }
  if (message.type === 'error') { setBusy(false); els.analysisSummary.textContent = 'Analysis failed'; els.previewNote.textContent = message.error || 'Processing failed.'; setStatus(message.error || 'Processing failed.'); }
}
function clearSelectedFile(reason = 'No video selected.') { analysisSerial++; resetWorker(); file = null; detection = null; resetOutputPreview(); if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; els.previewVideo.removeAttribute('src'); els.previewVideo.load(); els.previewPanel.classList.add('hidden'); els.previewPanel.classList.remove('portrait'); els.watermarkBox.classList.add('hidden'); clearCanvas(els.originalZoom); clearCanvas(els.cleanedZoom); setFileMessage(reason, reason !== 'No video selected.'); els.detectResult.textContent = 'Waiting for video...'; setBusy(false); }
function useFile(nextFile) { if (!nextFile) return; const validation = validateVideoFile(nextFile); if (!validation.ok) { clearSelectedFile(validation.reason); setStatus(validation.reason, 0); return; } analysisSerial++; resetWorker(); resetOutputPreview(); file = nextFile; detection = null; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(file); els.previewVideo.src = previewUrl; els.previewVideo.load(); els.previewPanel.classList.remove('hidden'); els.watermarkBox.classList.add('hidden'); clearCanvas(els.originalZoom); clearCanvas(els.cleanedZoom); setFileMessage(`${file.name} - ${formatFileSize(file.size)} - ${validation.mime}`); els.detectResult.textContent = 'Video loaded. Automatic watermark analysis is starting…'; els.analysisSummary.textContent = 'Preparing automatic analysis…'; els.previewNote.textContent = 'Detection starts in a Web Worker while the page stays responsive.'; setBusy(false); setStatus('Video loaded. Starting auto-detect…', 0); requestAnimationFrame(() => setTimeout(startAutoAnalysis, 40)); }
els.chooseFileBtn.addEventListener('click', () => { if (busy) return; els.fileInput.value = ''; els.fileInput.click(); });
els.fileInput.addEventListener('change', () => { const selected = els.fileInput.files?.[0]; if (selected) useFile(selected); });
for (const type of ['dragenter', 'dragover']) els.dropZone.addEventListener(type, (event) => { event.preventDefault(); els.dropZone.classList.add('drag'); });
for (const type of ['dragleave', 'drop']) els.dropZone.addEventListener(type, (event) => { event.preventDefault(); els.dropZone.classList.remove('drag'); });
els.dropZone.addEventListener('drop', (event) => useFile(event.dataTransfer?.files?.[0]));
els.analyzeBtn.addEventListener('click', () => { if (!file || busy) return; analysisSerial++; startFullAnalysis(); });
els.cleanBtn.addEventListener('click', () => { if (!file || busy) return; resetOutputPreview(); activeTag = `process:${analysisSerial}`; setBusy(true); setStatus('Starting export…', 0.01); const detectedPosition = detection?.detection?.detected ? detection.detection.position : null; ensureWorker().postMessage({ type: 'process', tag: activeTag, file, options: { sampleCount: Number(els.sampleCount.value), minConfidence: Number(els.minConfidence.value), manual: els.manualMode.checked ? { x: Number(els.wmX.value), y: Number(els.wmY.value), size: Number(els.wmSize.value) } : null, detectedRegion: !els.manualMode.checked && detectedPosition ? { x: detectedPosition.x, y: detectedPosition.y, size: detectedPosition.width } : null, alphaGain: Number(els.alphaGain.value), adaptiveAlpha: els.adaptiveAlpha.checked, temporalStabilize: els.temporalStabilize.checked, edgePolish: Number(els.edgePolish.value), forceCleanup: els.forceCleanup.checked, lowGate: Number(els.lowGate.value), bitrate: Number(els.bitrate.value) * 1_000_000 } }); });
els.cancelBtn.addEventListener('click', () => { worker?.postMessage({ type: 'cancel' }); setStatus('Cancelling…'); });
window.addEventListener('beforeunload', () => { if (outputUrl) URL.revokeObjectURL(outputUrl); if (previewUrl) URL.revokeObjectURL(previewUrl); resetWorker(); });

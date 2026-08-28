import { APP_VERSION } from '../version.js';
import { cleanVideo, inspectVideo } from './engine.js';
import { resetAdaptiveFinishState } from './adaptiveFinish.js';
import { clearActiveAlphaCalibration, setActiveAlphaCalibration } from './alpha.js';
import {
  calibrationMatchesRegion,
  createDetectionCalibrationCache,
  selectExportAlphaGain
} from './exportCalibrationCache.js';
import { prepareInspectResultForWorker } from './inspectResultBridge.js';

let cancelled = false;
const detectionCalibrationCache = createDetectionCalibrationCache(32);

function shouldCancel() { return cancelled; }

function cacheInspectionCalibration(file, result) {
  const internal = result?.internalDetection;
  if (!internal?.alphaMap || !internal?.position) return null;
  return detectionCalibrationCache.remember(file, internal);
}

async function ensureExportCalibration(file, options, progress) {
  const region = options?.detectedRegion || null;
  if (!region || options?.manual) return null;
  const cached = detectionCalibrationCache.get(file, region);
  if (cached) return cached;

  // A worker can be recreated after a transient module/network failure while the
  // page still keeps its cached public detection. Rebuild only the missing private
  // calibration state in that rare case rather than silently falling back to the
  // generic alpha profile and diverging from the preview.
  const refreshed = await inspectVideo(file, {
    sampleCount: options?.sampleCount,
    minConfidence: options?.minConfidence,
    edgePolish: options?.edgePolish,
    scanFraction: 1,
    onProgress: (payload) => progress?.({
      ...payload,
      status: `Restoring export calibration — ${payload?.status || payload?.phase || 'analyzing'}`
    }),
    shouldCancel
  });
  cacheInspectionCalibration(file, refreshed);
  return detectionCalibrationCache.get(file, region);
}

function activateExportCalibration(options, calibration) {
  clearActiveAlphaCalibration();
  const region = options?.detectedRegion || null;
  if (options?.manual || !region || !calibration || !calibrationMatchesRegion(calibration, region)) return { ...options };
  const size = Math.round(Number(region.size ?? region.width));
  if (!Number.isFinite(size) || size <= 0 || calibration.alphaMap.length !== size * size) return { ...options };
  setActiveAlphaCalibration(size, calibration.alphaMap, {
    position: calibration.position,
    alphaGain: calibration.alphaGain,
    candidateId: calibration.candidateId,
    source: 'inspect-cache'
  });
  return {
    ...options,
    alphaGain: selectExportAlphaGain(options?.alphaGain, calibration.alphaGain, 1)
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }

  cancelled = false;
  const tag = message.tag || null;
  const progress = (payload) => self.postMessage({ type: 'progress', tag, ...payload });

  try {
    if (message.type === 'inspect') {
      resetAdaptiveFinishState();
      const quickScan = String(tag || '').startsWith('quick:');
      const result = await inspectVideo(message.file, {
        ...message.options,
        scanFraction: Number.isFinite(message.options?.scanFraction)
          ? message.options.scanFraction
          : (quickScan ? 0.25 : 1),
        onProgress: progress,
        shouldCancel
      });
      if (cancelled) return self.postMessage({ type: 'cancelled', tag });
      cacheInspectionCalibration(message.file, result);
      const publicResult = prepareInspectResultForWorker(result);
      self.postMessage({ type: 'inspect-result', tag, result: publicResult });
      return;
    }

    if (message.type === 'process') {
      resetAdaptiveFinishState();
      const calibration = await ensureExportCalibration(message.file, message.options || {}, progress);
      if (cancelled) return self.postMessage({ type: 'cancelled', tag });
      const processOptions = activateExportCalibration(message.options || {}, calibration);
      let result;
      try {
        result = await cleanVideo(message.file, { ...processOptions, onProgress: progress, shouldCancel });
      } finally {
        // Never let one same-sized video's refined alpha leak into the next file.
        clearActiveAlphaCalibration();
      }
      if (cancelled) return self.postMessage({ type: 'cancelled', tag });
      const raw = result.buffer;
      const buffer = raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const meta = {
        ...(result.meta || {}),
        version: APP_VERSION,
        exportCalibration: calibration ? {
          reused: true,
          candidateId: calibration.candidateId || null,
          alphaGain: processOptions.alphaGain,
          position: calibration.position
        } : { reused: false }
      };
      self.postMessage({ type: 'process-result', tag, buffer, meta }, [buffer]);
    }
  } catch (error) {
    clearActiveAlphaCalibration();
    if (cancelled || error?.name === 'AbortError') {
      self.postMessage({ type: 'cancelled', tag });
    } else {
      self.postMessage({ type: 'error', tag, error: error?.message || String(error) });
    }
  }
};

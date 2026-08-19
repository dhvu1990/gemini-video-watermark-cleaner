import { APP_VERSION } from '../version.js';
import { cleanVideo, inspectVideo } from './engine.js';
import { resetAdaptiveFinishState } from './adaptiveFinish.js';
import { prepareInspectResultForWorker } from './inspectResultBridge.js';

let cancelled = false;

function shouldCancel() { return cancelled; }

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
      const publicResult = prepareInspectResultForWorker(result);
      self.postMessage({ type: 'inspect-result', tag, result: publicResult });
      return;
    }

    if (message.type === 'process') {
      resetAdaptiveFinishState();
      const result = await cleanVideo(message.file, { ...message.options, onProgress: progress, shouldCancel });
      if (cancelled) return self.postMessage({ type: 'cancelled', tag });
      const raw = result.buffer;
      const buffer = raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const meta = { ...(result.meta || {}), version: APP_VERSION };
      self.postMessage({ type: 'process-result', tag, buffer, meta }, [buffer]);
    }
  } catch (error) {
    if (cancelled || error?.name === 'AbortError') {
      self.postMessage({ type: 'cancelled', tag });
    } else {
      self.postMessage({ type: 'error', tag, error: error?.message || String(error) });
    }
  }
};

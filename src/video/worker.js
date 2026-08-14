import { cleanVideo, inspectVideo } from './engine.js';

let cancelled = false;

function progress(payload) {
  self.postMessage({ type: 'progress', ...payload });
}

function shouldCancel() { return cancelled; }

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  cancelled = false;
  try {
    if (message.type === 'inspect') {
      const result = await inspectVideo(message.file, { ...message.options, onProgress: progress, shouldCancel });
      if (cancelled) return self.postMessage({ type: 'cancelled' });
      const { internalDetection, ...publicResult } = result;
      self.postMessage({ type: 'inspect-result', result: publicResult });
      return;
    }
    if (message.type === 'process') {
      const result = await cleanVideo(message.file, { ...message.options, onProgress: progress, shouldCancel });
      if (cancelled) return self.postMessage({ type: 'cancelled' });
      const raw = result.buffer;
      const buffer = raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      self.postMessage({ type: 'process-result', buffer, meta: result.meta }, [buffer]);
    }
  } catch (error) {
    if (cancelled || error?.name === 'AbortError') {
      self.postMessage({ type: 'cancelled' });
    } else {
      self.postMessage({ type: 'error', error: error?.message || String(error) });
    }
  }
};

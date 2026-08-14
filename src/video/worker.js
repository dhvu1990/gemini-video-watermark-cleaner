import { cleanVideo, inspectVideo } from './engine.js';

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
      const result = await inspectVideo(message.file, { ...message.options, onProgress: progress, shouldCancel });
      if (cancelled) return self.postMessage({ type: 'cancelled', tag });
      const { internalDetection, ...publicResult } = result;
      self.postMessage({ type: 'inspect-result', tag, result: publicResult });
      return;
    }

    if (message.type === 'process') {
      const result = await cleanVideo(message.file, { ...message.options, onProgress: progress, shouldCancel });
      if (cancelled) return self.postMessage({ type: 'cancelled', tag });
      const raw = result.buffer;
      const buffer = raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      self.postMessage({ type: 'process-result', tag, buffer, meta: result.meta }, [buffer]);
    }
  } catch (error) {
    if (cancelled || error?.name === 'AbortError') {
      self.postMessage({ type: 'cancelled', tag });
    } else {
      self.postMessage({ type: 'error', tag, error: error?.message || String(error) });
    }
  }
};

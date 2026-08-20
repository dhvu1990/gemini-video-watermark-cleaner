export const BATCH_WORKER_MAX_RETRIES = 2;

function errorText(error) {
  if (!error) return '';
  const parts = [error?.name, error?.code, error?.message, String(error)]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return parts.join(' ');
}

export function isTransientBatchWorkerError(error) {
  if (error?.name === 'AbortError') return false;
  if (error?.code === 'BATCH_WORKER_TRANSPORT') return true;
  const text = errorText(error);
  if (!text) return false;
  return [
    'network error',
    'networkerror',
    'failed to fetch',
    'load failed',
    'loading module',
    'module script',
    'worker failed',
    'worker error',
    'connection reset',
    'connection closed',
    'connection lost',
    'fetch error'
  ].some((needle) => text.includes(needle));
}

export function shouldRetryBatchWorkerError(error, retriesUsed = 0, maxRetries = BATCH_WORKER_MAX_RETRIES) {
  const used = Math.max(0, Math.round(Number(retriesUsed) || 0));
  const limit = Math.max(0, Math.round(Number(maxRetries) || 0));
  return used < limit && isTransientBatchWorkerError(error);
}

export function batchWorkerRetryDelayMs(retryNumber = 1) {
  const attempt = Math.max(1, Math.round(Number(retryNumber) || 1));
  return Math.min(1400, 220 * (2 ** (attempt - 1)));
}

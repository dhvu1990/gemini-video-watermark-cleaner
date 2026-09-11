export const BATCH_STATUSES = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  SAVED: 'saved',
  ERROR: 'error',
  CANCELLED: 'cancelled'
});

export function batchFileKey(file) {
  return [file?.name || '', Number(file?.size) || 0, Number(file?.lastModified) || 0].join('::');
}

export function batchOutputName(fileName, mode = 'cleaned') {
  const name = String(fileName || 'video.mp4');
  const base = name.replace(/\.[^.]+$/, '') || 'video';
  if (mode === 'original') return /\.mp4$/i.test(name) ? name : `${base}.mp4`;
  return `${base}-cleaned.mp4`;
}

export function naturalBatchFileCompare(a, b) {
  const nameA = String(a?.name || '');
  const nameB = String(b?.name || '');
  const byName = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
  if (byName) return byName;
  const bySize = (Number(a?.size) || 0) - (Number(b?.size) || 0);
  if (bySize) return bySize;
  return (Number(a?.lastModified) || 0) - (Number(b?.lastModified) || 0);
}

export function sortBatchFiles(files = []) {
  return Array.from(files || []).sort(naturalBatchFileCompare);
}

export function isRunnableBatchStatus(status) {
  return status === BATCH_STATUSES.QUEUED || status === BATCH_STATUSES.ERROR || status === BATCH_STATUSES.CANCELLED;
}

export function runnableBatchItems(items = []) {
  return items.filter((item) => isRunnableBatchStatus(item?.status));
}

export function summarizeBatch(items = []) {
  const summary = { total: items.length, queued: 0, processing: 0, done: 0, saved: 0, error: 0, cancelled: 0, finished: 0 };
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(summary, item?.status)) summary[item.status] += 1;
  }
  summary.finished = summary.done + summary.saved;
  return summary;
}

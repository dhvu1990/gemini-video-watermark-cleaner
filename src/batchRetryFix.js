export function installBatchRetryResume(doc = document) {
  if (!doc?.addEventListener) return false;
  doc.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button');
    if (!button || button.textContent?.trim() !== 'Retry') return;
    queueMicrotask(() => {
      const runButton = doc.getElementById('batchCleanAllBtn');
      if (runButton && !runButton.disabled) runButton.click();
    });
  });
  return true;
}

if (typeof document !== 'undefined') installBatchRetryResume(document);

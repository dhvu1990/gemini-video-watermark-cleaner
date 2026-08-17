export function releaseSourcePreviewForOverwrite({ previewVideo, fileInput, revoke = (url) => URL.revokeObjectURL(url) } = {}) {
  const sourceUrl = String(previewVideo?.currentSrc || previewVideo?.src || '');
  try { previewVideo?.pause?.(); } catch {}
  try { previewVideo?.removeAttribute?.('src'); } catch {}
  try { previewVideo?.load?.(); } catch {}
  if (sourceUrl.startsWith('blob:')) {
    try { revoke(sourceUrl); } catch {}
  }
  if (fileInput) {
    try { fileInput.value = ''; } catch {}
  }
  return { released: Boolean(sourceUrl), sourceUrl };
}

export function installDownloadOverwriteGuard(doc = document) {
  const downloadBtn = doc?.getElementById?.('downloadBtn');
  const previewVideo = doc?.getElementById?.('previewVideo');
  const fileInput = doc?.getElementById?.('fileInput');
  if (!downloadBtn) return false;

  downloadBtn.addEventListener('click', (event) => {
    if (downloadBtn.classList?.contains('disabled') || downloadBtn.getAttribute?.('aria-disabled') === 'true') {
      event.preventDefault();
      return;
    }
    releaseSourcePreviewForOverwrite({ previewVideo, fileInput });
  }, { capture: true });
  return true;
}

if (typeof document !== 'undefined') installDownloadOverwriteGuard(document);

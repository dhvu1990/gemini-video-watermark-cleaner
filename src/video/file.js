const FALLBACK_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

export function getFileExtension(name = '') {
  const normalized = String(name).trim().toLowerCase();
  const dot = normalized.lastIndexOf('.');
  if (dot <= 0 || dot === normalized.length - 1) return '';
  return normalized.slice(dot);
}

export function validateVideoFile(file) {
  if (!file) {
    return { ok: false, reason: 'No file selected.' };
  }

  const type = String(file.type || '').trim().toLowerCase();
  const extension = getFileExtension(file.name);
  const mimeLooksVideo = type.startsWith('video/');
  const extensionLooksVideo = FALLBACK_VIDEO_EXTENSIONS.has(extension);

  if (!mimeLooksVideo && !extensionLooksVideo) {
    const detail = type ? `MIME ${type}` : 'unknown MIME type';
    return {
      ok: false,
      reason: `Unsupported file: ${file.name || 'unnamed file'} (${detail}). Choose MP4, MOV, M4V, or WebM.`
    };
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, reason: 'The selected video is empty or its size cannot be read.' };
  }

  return {
    ok: true,
    mime: type || 'unknown MIME',
    extension: extension || 'unknown extension',
    acceptedBy: mimeLooksVideo ? 'mime' : 'extension'
  };
}

export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

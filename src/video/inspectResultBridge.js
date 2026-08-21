import {
  classifyHighContrastAdjacency,
  measureHighContrastAdjacency
} from './highContrastAdjacencyDiagnostics.js';

function cloneRoi(roi) {
  if (!roi?.data || !roi.width || !roi.height) return roi;
  const data = roi.data instanceof Uint8ClampedArray
    ? new Uint8ClampedArray(roi.data)
    : new Uint8ClampedArray(roi.data || []);
  return { ...roi, data };
}

export function prepareInspectResultForWorker(result = null) {
  if (!result || typeof result !== 'object') return result;

  const { internalDetection, ...publicResult } = result;
  const alphaMap = internalDetection?.alphaMap || null;
  const detection = publicResult.detection || null;
  const preview = publicResult.preview || null;

  // A review-only candidate must never display a synthetic inverse-alpha result.
  // Cleaning a wrong ROI can manufacture a second Gemini-shaped ghost and makes
  // the preview look as if the tool actually modified the video. Keep the candidate
  // box for review, but make the cleaned preview byte-identical to the original.
  if (preview?.original?.data && detection?.safeToClean !== true) {
    preview.cleaned = cloneRoi(preview.original);
    preview.previewSuppressed = true;
    preview.suppressionReason = detection?.reason || 'unsafe-detection';
    preview.antiStreak = preview.antiStreak || { structured: {}, riskFlags: [] };
    const existingFlags = Array.isArray(preview.antiStreak.riskFlags)
      ? preview.antiStreak.riskFlags.filter(Boolean)
      : [];
    if (!existingFlags.includes('unsafe-preview-suppressed')) existingFlags.push('unsafe-preview-suppressed');
    preview.antiStreak.riskFlags = existingFlags;
  }

  if (!alphaMap) return publicResult;

  if (preview?.cleaned?.data && detection?.safeToClean === true) {
    const adjacency = measureHighContrastAdjacency(preview.cleaned, alphaMap);
    const classification = classifyHighContrastAdjacency(adjacency);
    const antiStreak = preview.antiStreak || { structured: {}, riskFlags: [] };
    const existingFlags = Array.isArray(antiStreak.riskFlags) ? antiStreak.riskFlags.filter(Boolean) : [];
    const riskFlags = classification.level === 'high' && !existingFlags.includes('high-contrast-adjacency')
      ? [...existingFlags, 'high-contrast-adjacency']
      : existingFlags;
    preview.antiStreak = {
      ...antiStreak,
      structured: {
        ...(antiStreak.structured || {}),
        highContrastAdjacency: {
          ...adjacency,
          level: classification.level,
          reason: classification.reason,
          provisional: true
        }
      },
      riskFlags
    };
  }

  return {
    ...publicResult,
    internalDetection: { alphaMap }
  };
}

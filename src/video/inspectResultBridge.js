import {
  classifyHighContrastAdjacency,
  measureHighContrastAdjacency
} from './highContrastAdjacencyDiagnostics.js';

export function prepareInspectResultForWorker(result = null) {
  if (!result || typeof result !== 'object') return result;

  const { internalDetection, ...publicResult } = result;
  const alphaMap = internalDetection?.alphaMap || null;

  if (!alphaMap) return publicResult;

  const preview = publicResult.preview || null;
  if (preview?.cleaned?.data) {
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

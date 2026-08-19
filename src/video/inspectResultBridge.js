export function prepareInspectResultForWorker(result = null) {
  if (!result || typeof result !== 'object') return result;

  const { internalDetection, ...publicResult } = result;
  const alphaMap = internalDetection?.alphaMap || null;

  if (!alphaMap) return publicResult;

  return {
    ...publicResult,
    internalDetection: { alphaMap }
  };
}

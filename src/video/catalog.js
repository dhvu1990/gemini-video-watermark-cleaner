const REF_W = 1920;
const REF_H = 1080;

function candidate(id, width, height, size, marginRight, marginBottom, priority = 10) {
  const x = Math.round(width - marginRight - size);
  const y = Math.round(height - marginBottom - size);
  return {
    id,
    x,
    y,
    size: Math.round(size),
    width: Math.round(size),
    height: Math.round(size),
    marginRight: Math.round(marginRight),
    marginBottom: Math.round(marginBottom),
    priority
  };
}

function valid(c, width, height) {
  return c.size >= 16 && c.x >= 0 && c.y >= 0 && c.x + c.size <= width && c.y + c.size <= height;
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.x}:${item.y}:${item.size}`;
    const previous = map.get(key);
    if (!previous || item.priority < previous.priority) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => a.priority - b.priority);
}

export function resolveVideoWatermarkCandidates(width, height) {
  if (!(width > 0 && height > 0)) return [];
  const scale = Math.min(width / REF_W, height / REF_H);
  const projected = [
    candidate('veo-standard', width, height, 72 * scale, 108 * scale, 108 * scale, 2),
    candidate('veo-inset', width, height, 72 * scale, 144 * scale, 144 * scale, 3)
  ];
  const exact = [];

  if (width === 1920 && height === 1080) {
    exact.push(candidate('veo-1080p-standard', width, height, 72, 108, 108, 0));
    exact.push(candidate('veo-1080p-inset', width, height, 72, 144, 144, 1));
  }
  if (width === 1280 && height === 720) {
    exact.push(candidate('veo-720p-standard', width, height, 48, 72, 72, 0));
    exact.push(candidate('veo-720p-inset', width, height, 48, 96, 96, 1));
    exact.push(candidate('veo-720p-compact', width, height, 44, 29, 40, 2));
  }
  if (width === 1080 && height === 1920) {
    exact.push(candidate('veo-portrait-1080-standard', width, height, 72, 108, 108, 0));
    exact.push(candidate('veo-portrait-1080-inset', width, height, 72, 144, 144, 1));
  }
  if (width === 720 && height === 1280) {
    exact.push(candidate('veo-portrait-720-relocated', width, height, 48, 96, 96, 0));
    exact.push(candidate('veo-portrait-720-standard', width, height, 48, 72, 72, 1));
    exact.push(candidate('veo-portrait-720-compact', width, height, 44, 29, 40, 3));
    exact.push(candidate('veo-portrait-720-mini', width, height, 24, 48, 48, 4));
  }

  return dedupe([...exact, ...projected].filter((item) => valid(item, width, height)));
}

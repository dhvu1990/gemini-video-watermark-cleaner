import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideoWatermarkCandidates } from '../src/video/catalog.js';

test('1080p catalog includes standard Veo anchor', () => {
  const candidates = resolveVideoWatermarkCandidates(1920, 1080);
  const standard = candidates.find((item) => item.id === 'veo-1080p-standard');
  assert.ok(standard);
  assert.deepEqual(
    { x: standard.x, y: standard.y, size: standard.size, right: standard.marginRight, bottom: standard.marginBottom },
    { x: 1740, y: 900, size: 72, right: 108, bottom: 108 }
  );
});

test('720p catalog keeps known standard and compact candidates', () => {
  const ids = resolveVideoWatermarkCandidates(1280, 720).map((item) => item.id);
  assert.ok(ids.includes('veo-720p-standard'));
  assert.ok(ids.includes('veo-720p-compact'));
});

test('portrait catalog stays inside frame bounds', () => {
  for (const item of resolveVideoWatermarkCandidates(720, 1280)) {
    assert.ok(item.x >= 0 && item.y >= 0);
    assert.ok(item.x + item.size <= 720);
    assert.ok(item.y + item.size <= 1280);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideoWatermarkCandidates } from '../src/video/catalog.js';

test('portrait 1080 exact inset anchor is preferred over standard for faint ambiguous cases', () => {
  const candidates = resolveVideoWatermarkCandidates(1080, 1920);
  const inset = candidates.find((candidate) => candidate.id === 'veo-portrait-1080-inset');
  const standard = candidates.find((candidate) => candidate.id === 'veo-portrait-1080-standard');
  assert.ok(inset);
  assert.ok(standard);
  assert.equal(inset.x, 864);
  assert.equal(inset.y, 1704);
  assert.equal(inset.size, 72);
  assert.equal(standard.x, 900);
  assert.equal(standard.y, 1740);
  assert.equal(inset.priority, 0);
  assert.ok(standard.priority >= 10, standard.priority);
});

test('portrait exact anchors remain 36 px apart on both axes', () => {
  const candidates = resolveVideoWatermarkCandidates(1080, 1920);
  const inset = candidates.find((candidate) => candidate.id === 'veo-portrait-1080-inset');
  const standard = candidates.find((candidate) => candidate.id === 'veo-portrait-1080-standard');
  assert.equal(standard.x - inset.x, 36);
  assert.equal(standard.y - inset.y, 36);
});

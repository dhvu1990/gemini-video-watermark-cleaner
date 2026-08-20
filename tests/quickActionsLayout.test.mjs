import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mount = fs.readFileSync(new URL('../src/batch-mount.js', import.meta.url), 'utf8');

test('single-video clean/export panel is moved directly below the video chooser', () => {
  assert.match(mount, /const chooserPanel = doc\.getElementById\('dropZone'\)/);
  assert.match(mount, /chooserPanel\.after\(exportPanel\)/);
  assert.match(mount, /Quick clean \/ Export/);
});

test('batch panel is mounted after the quick clean/export panel', () => {
  assert.match(mount, /exportPanel\.after\(panel\)/);
  assert.match(mount, /single worker is reused across the queue/);
});

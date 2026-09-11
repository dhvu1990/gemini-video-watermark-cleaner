import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync(new URL('../src/batch-ui.js', import.meta.url), 'utf8');
const mount = fs.readFileSync(new URL('../src/batch-mount.js', import.meta.url), 'utf8');

test('newly added batch files automatically enter sequential preview analysis', () => {
  assert.match(ui, /setTimeout\(\(\) => analyzeBatchPreviews\(added\.sort\(/);
  assert.match(ui, /async function analyzeBatchPreviews/);
  assert.match(ui, /for \(const item of items\)/);
  assert.match(ui, /await analyzeBatchItem\(item, options, \{ preview: true \}\)/);
  assert.match(ui, /item\.preview = result\.preview \|\| null/);
});

test('batch cleaning reuses cached detection while inspect settings are unchanged', () => {
  assert.match(ui, /sameBatchInspectOptions\(item\.inspectOptions, options\)/);
  assert.match(ui, /return item\.detection/);
  assert.match(ui, /await analyzeBatchItem\(item, options, \{ preview: false \}\)/);
});

test('each batch row renders its own detection summary and original-cleaned ROI previews', () => {
  assert.match(ui, /appendDetectionPreview\(row, item\)/);
  assert.match(ui, /ZOOMED ORIGINAL/);
  assert.match(ui, /ZOOMED CLEANED/);
  assert.match(mount, /batch-detect-zooms/);
  assert.match(mount, /each file is auto-detected sequentially/i);
});

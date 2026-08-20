import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync(new URL('../src/batch-ui.js', import.meta.url), 'utf8');
const mount = fs.readFileSync(new URL('../src/batch-mount.js', import.meta.url), 'utf8');

test('newly added batch files automatically enter sequential preview analysis', () => {
  assert.match(ui, /setTimeout\(\(\) => analyzeBatchPreviews\(added\), 0\)/);
  assert.match(ui, /async function analyzeBatchPreviews/);
  assert.match(ui, /await analyzeOnePreview\(item, options\)/);
  assert.match(ui, /item\.preview = inspected\.result\?\.preview \|\| null/);
});

test('batch cleaning reuses cached detection while inspect settings are unchanged', () => {
  assert.match(ui, /sameBatchInspectOptions\(item\.inspectOptions, currentInspectOptions\)/);
  assert.match(ui, /Using cached auto-detect/);
});

test('each batch row renders its own detection summary and original-cleaned ROI previews', () => {
  assert.match(ui, /appendDetectionPreview\(row, item\)/);
  assert.match(ui, /ZOOMED ORIGINAL/);
  assert.match(ui, /ZOOMED CLEANED/);
  assert.match(mount, /batch-detect-zooms/);
  assert.match(mount, /each file is auto-detected sequentially/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const batchUi = fs.readFileSync(new URL('../src/batch-ui.js', import.meta.url), 'utf8');

test('batch picker snapshots FileList, clears the native input, then defers ingestion', () => {
  assert.match(batchUi, /addEventListener\('change', \(event\) =>/);
  assert.match(batchUi, /const files = Array\.from\(event\.target\.files \|\| \[\]\)/);
  assert.match(batchUi, /event\.target\.value = ''/);
  assert.match(batchUi, /setTimeout\(\(\) => addFilesDeferred\(files\), 0\)/);
});

test('large selections are ingested in yielded chunks instead of one blocking task', () => {
  assert.match(batchUi, /const chunkSize = 24/);
  assert.match(batchUi, /await nextFrame\(\)/);
  assert.match(batchUi, /state\.ingesting/);
});

test('retry is handled directly by batch UI and restarts processing', () => {
  assert.match(batchUi, /function retryItem\(key\)/);
  assert.match(batchUi, /setTimeout\(\(\) => runBatch\(\), 0\)/);
});

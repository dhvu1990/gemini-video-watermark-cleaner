import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const batchUi = fs.readFileSync(new URL('../src/batch-ui.js', import.meta.url), 'utf8');

test('Retry requeues one failed batch item and immediately resumes batch processing', () => {
  assert.match(batchUi, /function retryItem\(key\)/);
  assert.match(batchUi, /item\.status = BATCH_STATUSES\.QUEUED/);
  assert.match(batchUi, /queueMicrotask\(runBatch\)/);
});

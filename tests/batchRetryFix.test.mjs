import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const retryFix = fs.readFileSync(new URL('../src/batchRetryFix.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/calibration-ui.js', import.meta.url), 'utf8');

test('batch retry fix resumes Clean all after Retry requeues the failed item', () => {
  assert.match(retryFix, /button\.textContent\?\.trim\(\) !== 'Retry'/);
  assert.match(retryFix, /queueMicrotask/);
  assert.match(retryFix, /batchCleanAllBtn/);
  assert.match(retryFix, /runButton\.click\(\)/);
  assert.match(ui, /import '\.\/batchRetryFix\.js'/);
});

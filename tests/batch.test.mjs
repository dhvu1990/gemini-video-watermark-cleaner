import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFileKey, batchOutputName, BATCH_STATUSES, runnableBatchItems, summarizeBatch } from '../src/batch.js';

test('batch output names support cleaned suffix and original-name overwrite mode', () => {
  assert.equal(batchOutputName('clip.mp4', 'cleaned'), 'clip-cleaned.mp4');
  assert.equal(batchOutputName('clip.mov', 'cleaned'), 'clip-cleaned.mp4');
  assert.equal(batchOutputName('clip.mp4', 'original'), 'clip.mp4');
  assert.equal(batchOutputName('clip.mov', 'original'), 'clip.mp4');
});

test('batch file keys separate same-name files with different metadata', () => {
  assert.notEqual(batchFileKey({ name: 'a.mp4', size: 10, lastModified: 1 }), batchFileKey({ name: 'a.mp4', size: 11, lastModified: 1 }));
});

test('batch runner retries queued, error and cancelled items but not finished items', () => {
  const items = [
    { status: BATCH_STATUSES.QUEUED }, { status: BATCH_STATUSES.ERROR }, { status: BATCH_STATUSES.CANCELLED },
    { status: BATCH_STATUSES.DONE }, { status: BATCH_STATUSES.SAVED }
  ];
  assert.equal(runnableBatchItems(items).length, 3);
});

test('batch summary counts saved and downloadable results as finished', () => {
  const summary = summarizeBatch([
    { status: BATCH_STATUSES.SAVED }, { status: BATCH_STATUSES.DONE }, { status: BATCH_STATUSES.ERROR }
  ]);
  assert.deepEqual({ total: summary.total, finished: summary.finished, error: summary.error }, { total: 3, finished: 2, error: 1 });
});

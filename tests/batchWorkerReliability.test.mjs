import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_WORKER_MAX_RETRIES,
  batchWorkerRetryDelayMs,
  isTransientBatchWorkerError,
  shouldRetryBatchWorkerError
} from '../src/batchWorkerReliability.js';

test('network and worker transport failures are classified as transient', () => {
  assert.equal(isTransientBatchWorkerError(new Error('network error')), true);
  assert.equal(isTransientBatchWorkerError(new Error('Failed to fetch dynamically imported module')), true);
  const transport = new Error('worker module failed');
  transport.code = 'BATCH_WORKER_TRANSPORT';
  assert.equal(isTransientBatchWorkerError(transport), true);
});

test('processing and cancellation errors are not retried as transport failures', () => {
  assert.equal(isTransientBatchWorkerError(new Error('Detection confidence 0.030 is below 0.120')), false);
  const cancelled = new Error('Cancelled');
  cancelled.name = 'AbortError';
  assert.equal(isTransientBatchWorkerError(cancelled), false);
});

test('automatic retries are bounded', () => {
  const error = new Error('network error');
  assert.equal(BATCH_WORKER_MAX_RETRIES, 2);
  assert.equal(shouldRetryBatchWorkerError(error, 0), true);
  assert.equal(shouldRetryBatchWorkerError(error, 1), true);
  assert.equal(shouldRetryBatchWorkerError(error, 2), false);
});

test('retry delay uses short bounded exponential backoff', () => {
  assert.equal(batchWorkerRetryDelayMs(1), 220);
  assert.equal(batchWorkerRetryDelayMs(2), 440);
  assert.ok(batchWorkerRetryDelayMs(10) <= 1400);
});

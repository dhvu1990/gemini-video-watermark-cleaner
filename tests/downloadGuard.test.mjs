import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSourcePreviewForOverwrite } from '../src/downloadGuard.js';

test('overwrite guard detaches and revokes the selected source preview before browser download', () => {
  const calls = [];
  const previewVideo = {
    currentSrc: 'blob:https://example.test/source-video',
    pause() { calls.push('pause'); },
    removeAttribute(name) { calls.push(`remove:${name}`); },
    load() { calls.push('load'); }
  };
  const fileInput = { value: 'C:/fakepath/source.mp4' };
  const revoked = [];
  const result = releaseSourcePreviewForOverwrite({
    previewVideo,
    fileInput,
    revoke: (url) => revoked.push(url)
  });

  assert.equal(result.released, true);
  assert.deepEqual(calls, ['pause', 'remove:src', 'load']);
  assert.deepEqual(revoked, ['blob:https://example.test/source-video']);
  assert.equal(fileInput.value, '');
});

test('overwrite guard is harmless when no source preview is active', () => {
  const previewVideo = {
    currentSrc: '', src: '',
    pause() {}, removeAttribute() {}, load() {}
  };
  const fileInput = { value: '' };
  const revoked = [];
  const result = releaseSourcePreviewForOverwrite({ previewVideo, fileInput, revoke: (url) => revoked.push(url) });
  assert.equal(result.released, false);
  assert.deepEqual(revoked, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize, getFileExtension, validateVideoFile } from '../src/video/file.js';

test('accepts a normal browser video MIME type', () => {
  const result = validateVideoFile({ name: 'gemini.mp4', type: 'video/mp4', size: 1024 });
  assert.equal(result.ok, true);
  assert.equal(result.acceptedBy, 'mime');
});

test('accepts MP4 by extension when browser MIME is empty', () => {
  const result = validateVideoFile({ name: 'Gemini Output.MP4', type: '', size: 2048 });
  assert.equal(result.ok, true);
  assert.equal(result.acceptedBy, 'extension');
  assert.equal(result.extension, '.mp4');
});

test('accepts common MOV M4V and WebM extension fallbacks', () => {
  for (const name of ['clip.mov', 'clip.m4v', 'clip.webm']) {
    assert.equal(validateVideoFile({ name, type: '', size: 1 }).ok, true, name);
  }
});

test('rejects unrelated file types with a useful reason', () => {
  const result = validateVideoFile({ name: 'notes.txt', type: 'text/plain', size: 100 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Unsupported file/);
});

test('rejects an empty selected video', () => {
  const result = validateVideoFile({ name: 'empty.mp4', type: 'video/mp4', size: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test('extension and size helpers are stable', () => {
  assert.equal(getFileExtension('video.MP4'), '.mp4');
  assert.equal(getFileExtension('no-extension'), '');
  assert.equal(formatFileSize(1024 * 1024), '1.0 MB');
});

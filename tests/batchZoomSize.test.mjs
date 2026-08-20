import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mount = fs.readFileSync(new URL('../src/batch-mount.js', import.meta.url), 'utf8');

test('batch zoom cards are doubled from 92px to 184px columns', () => {
  assert.match(mount, /grid-template-columns:repeat\(2,184px\)/);
});

test('batch zoom canvases are doubled from 78px to 156px', () => {
  assert.match(mount, /width:156px;height:156px/);
});

test('mobile batch zooms remain responsive instead of forcing 184px columns', () => {
  assert.match(mount, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(mount, /aspect-ratio:1\/1/);
});

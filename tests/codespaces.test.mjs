import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const configPath = new URL('../.devcontainer/devcontainer.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

test('Codespaces forwards Vite on 5173 without public visibility override', () => {
  assert.ok(Array.isArray(config.forwardPorts));
  assert.ok(config.forwardPorts.includes(5173));
  const attrs = config.portsAttributes?.['5173'];
  assert.ok(attrs);
  assert.equal(Object.prototype.hasOwnProperty.call(attrs, 'visibility'), false);
});

test('Codespaces installs dependencies and pinned alpha assets', () => {
  assert.match(config.postCreateCommand || '', /npm install/);
  assert.match(config.postCreateCommand || '', /npm run setup:alpha/);
});

test('Codespaces starts Vite on 0.0.0.0:5173', () => {
  assert.match(config.postStartCommand || '', /npm run dev/);
  assert.match(config.postStartCommand || '', /--host 0\.0\.0\.0/);
  assert.match(config.postStartCommand || '', /--port 5173/);
});

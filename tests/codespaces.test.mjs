import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const configPath = new URL('../.devcontainer/devcontainer.json', import.meta.url);
const launcherPath = new URL('../.devcontainer/start-vite.sh', import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const launcher = fs.readFileSync(launcherPath, 'utf8');

test('Codespaces forwards Vite on 5173 without public visibility override', () => {
  assert.ok(Array.isArray(config.forwardPorts));
  assert.ok(config.forwardPorts.includes(5173));
  const attrs = config.portsAttributes?.['5173'];
  assert.ok(attrs);
  assert.equal(Object.prototype.hasOwnProperty.call(attrs, 'visibility'), false);
});

test('Codespaces uses HTTP internally for the Vite forwarded port', () => {
  assert.equal(config.portsAttributes?.['5173']?.protocol, 'http');
});

test('Codespaces installs dependencies and pinned alpha assets', () => {
  assert.match(config.postCreateCommand || '', /npm install/);
  assert.match(config.postCreateCommand || '', /npm run setup:alpha/);
});

test('Codespaces postStart delegates to the robust launcher', () => {
  assert.equal(config.postStartCommand, 'bash .devcontainer/start-vite.sh');
});

test('Codespaces launcher detaches Vite and health-checks localhost:5173', () => {
  assert.match(launcher, /setsid -f/);
  assert.match(launcher, /npm run dev -- --host 0\.0\.0\.0 --port/);
  assert.match(launcher, /127\.0\.0\.1:\$\{PORT\}/);
  assert.match(launcher, /gemini-vite\.log/);
});

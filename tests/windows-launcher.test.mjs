import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync(new URL('../tools/windows/GeminiCleaner.ps1', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../tools/windows/Install-GeminiCleaner.ps1', import.meta.url), 'utf8');
const cmd = fs.readFileSync(new URL('../tools/windows/GeminiCleaner.cmd', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/calibration-ui.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/video/worker.js', import.meta.url), 'utf8');
const version = fs.readFileSync(new URL('../src/version.js', import.meta.url), 'utf8');

test('Windows launcher discovers Codespace by repository instead of hard-coding one URL', () => {
  assert.match(launcher, /dhvu1990\/gemini-video-watermark-cleaner/);
  assert.match(launcher, /codespace', 'list'/);
  assert.doesNotMatch(launcher, /fictional-space-guacamole/);
  assert.doesNotMatch(launcher, /app\.github\.dev/);
});

test('Windows launcher starts stopped Codespace and waits for Available', () => {
  assert.match(launcher, /\/user\/codespaces\/\$name\/start/);
  assert.match(launcher, /Wait-CodespaceAvailable/);
  assert.match(launcher, /'Available'/);
});

test('Windows launcher requires private port 5173 and opens dynamic browseUrl', () => {
  assert.match(launcher, /\$Port = 5173/);
  assert.match(launcher, /'browseUrl,sourcePort,visibility'/);
  assert.match(launcher, /visibility -ne 'private'/);
  assert.match(launcher, /ports', 'visibility'/);
  assert.match(launcher, /Start-Process \$url/);
});

test('Windows launcher waits for a stable private browseUrl before opening it', () => {
  assert.match(launcher, /\$StablePortChecks = 3/);
  assert.match(launcher, /\$ProxyWarmupSeconds = 8/);
  assert.match(launcher, /stable checks/);
  assert.match(launcher, /forwarded-port proxy to finish warming up/);
});

test('installer keeps auth in GitHub CLI and creates a local desktop shortcut', () => {
  assert.match(installer, /winget install --id GitHub\.cli/);
  assert.match(installer, /gh auth login --hostname github\.com --git-protocol https --web --clipboard/);
  assert.match(installer, /gh auth refresh --hostname github\.com --scopes codespace/);
  assert.match(installer, /LOCALAPPDATA/);
  assert.match(installer, /CreateShortcut/);
  assert.doesNotMatch(installer, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(installer, /github_pat_[A-Za-z0-9_]+/);
  assert.match(cmd, /ExecutionPolicy Bypass/);
});

test('runtime version uses one shared source of truth', () => {
  assert.match(version, /export const APP_VERSION = '1\.0\.40'/);
  assert.match(ui, /import \{ APP_VERSION \} from '\.\/version\.js'/);
  assert.match(worker, /import \{ APP_VERSION \} from '\.\.\/version\.js'/);
  assert.match(ui, /firstBadge\.textContent = `v\$\{APP_VERSION\}`/);
});

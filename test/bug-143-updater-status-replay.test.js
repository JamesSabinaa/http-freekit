import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const updater = fs.readFileSync(path.join(process.cwd(), 'electron', 'updater.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(process.cwd(), 'electron', 'preload.cjs'), 'utf8');
const renderer = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

test('main process stores and exposes the latest validated updater status', () => {
  assert.match(updater, /currentStatus = \{ \.\.\.data \}/);
  assert.match(updater, /ipcMain\.handle\('updater-get-status',[\s\S]*validateIpcSender\(event\)[\s\S]*return \{ \.\.\.currentStatus \}/);
});

test('preload exposes the updater status query through the invoke allowlist', () => {
  assert.match(preload, /'updater-get-status'/);
  assert.match(preload, /getUpdaterStatus:\s*\(\) => safeInvoke\('updater-get-status'\)/);
});

test('renderer subscribes before replaying current updater state', () => {
  const start = renderer.indexOf('(function initAutoUpdaterUI()');
  const end = renderer.indexOf('// cURL paste detection', start);
  const ui = renderer.slice(start, end);
  const subscribeIndex = ui.indexOf('onUpdaterStatus(handleUpdaterStatus)');
  const queryIndex = ui.indexOf('getUpdaterStatus()');

  assert.notEqual(subscribeIndex, -1);
  assert.ok(queryIndex > subscribeIndex);
  assert.match(ui, /if \(document\.getElementById\('installUpdateBtn'\)\) return/);
});

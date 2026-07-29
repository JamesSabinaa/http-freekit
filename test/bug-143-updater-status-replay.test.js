import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const updater = fs.readFileSync(path.join(process.cwd(), 'electron', 'updater.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(process.cwd(), 'electron', 'preload.cjs'), 'utf8');
const renderer = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function loadUpdater() {
  const filename = path.join(process.cwd(), 'electron', 'updater.cjs');
  const module = { exports: {} };
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = () => Promise.resolve(null);
  autoUpdater.downloadUpdate = () => Promise.resolve(null);
  autoUpdater.setFeedURL = () => {};
  autoUpdater.quitAndInstall = () => {};
  const ipcHandlers = new Map();
  const electron = {
    app: { getVersion: () => '1.0.0', isPackaged: true },
    dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
    ipcMain: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
      removeHandler: channel => ipcHandlers.delete(channel)
    },
    shell: { openExternal: () => Promise.resolve() }
  };
  const mocks = {
    electron,
    'electron-updater': { autoUpdater },
    './update-platform.cjs': { shouldForceLinuxUpdateChecks: () => false }
  };
  const context = vm.createContext({
    URL,
    console,
    process: { platform: 'win32', env: {}, versions: process.versions },
    setTimeout: () => ({}),
    clearTimeout() {},
    setInterval: () => ({}),
    clearInterval() {}
  });
  const wrapper = vm.runInContext(
    `(function (require, module, exports, __filename, __dirname) { ${updater}\n})`,
    context,
    { filename }
  );
  wrapper(request => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    throw new Error(`Unexpected CommonJS dependency: ${request}`);
  }, module, module.exports, filename, path.dirname(filename));
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send() {} }
  };
  module.exports.initAutoUpdater(mainWindow, { validateSender: () => true });
  return {
    autoUpdater,
    checkNow: () => ipcHandlers.get('updater-check-now')({}),
    getStatus: () => ipcHandlers.get('updater-get-status')({}),
    stop: module.exports.stopAutoUpdater
  };
}

async function settleUpdaterTasks() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

test('main process stores downloaded readiness separately from transient status', async () => {
  assert.match(updater, /let statusEventId = 0/);
  assert.match(updater, /data = \{ \.\.\.data, eventId: \+\+statusEventId \}/);
  assert.match(updater, /currentStatus = \{ \.\.\.data \}/);
  assert.match(updater, /downloadedUpdateStatus = \{ \.\.\.data \}/);
  assert.match(updater, /return getUpdaterStatusSnapshot\(\)/);
  assert.match(updater, /status: 'install-canceled',[\s\S]*version: downloadedUpdateStatus\?\.version \|\| currentStatus\.version/);

  const harness = loadUpdater();
  const firstCheck = harness.checkNow();
  harness.autoUpdater.emit('update-available', { version: '2.0.0' });
  await firstCheck;
  await settleUpdaterTasks();
  harness.autoUpdater.emit('update-downloaded', { version: '2.0.0' });
  await settleUpdaterTasks();

  const downloaded = JSON.parse(JSON.stringify(harness.getStatus()));
  assert.equal(downloaded.status, 'update-downloaded');
  assert.equal(downloaded.downloadedUpdate.status, 'update-downloaded');
  assert.equal(downloaded.downloadedUpdate.version, '2.0.0');
  assert.equal(downloaded.downloadedUpdate.eventId, downloaded.eventId);

  const laterCheck = harness.checkNow();
  harness.autoUpdater.emit('update-not-available');
  await laterCheck;
  const upToDate = JSON.parse(JSON.stringify(harness.getStatus()));
  assert.equal(upToDate.status, 'up-to-date');
  assert.equal(upToDate.downloadedUpdate.version, '2.0.0');

  const failingCheck = harness.checkNow();
  harness.autoUpdater.emit('error', new Error('later check failed'));
  await failingCheck;
  const failed = JSON.parse(JSON.stringify(harness.getStatus()));
  assert.equal(failed.status, 'error');
  assert.equal(failed.downloadedUpdate.version, '2.0.0');
  harness.stop();
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
  assert.match(ui, /if \(statusKey === lastUpdaterStatusKey\) return/);
  assert.match(ui, /status\?\.downloadedUpdate[\s\S]*handleUpdaterStatus\(status\.downloadedUpdate\)/);
  assert.match(ui, /case 'update-downloaded':[\s\S]*updateVersion = data\.version/);
});

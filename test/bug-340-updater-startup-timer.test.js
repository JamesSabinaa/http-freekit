import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function createTimerHarness() {
  const timeouts = [];
  const intervals = [];
  const clearTimeoutCalls = [];
  const clearIntervalCalls = [];

  return {
    timeouts,
    intervals,
    clearTimeoutCalls,
    clearIntervalCalls,
    setTimeout(callback, delay) {
      const handle = {
        delay,
        active: true,
        run() {
          if (!handle.active) return false;
          handle.active = false;
          callback();
          return true;
        }
      };
      timeouts.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      clearTimeoutCalls.push(handle);
      handle.active = false;
    },
    setInterval(callback, delay) {
      const handle = {
        delay,
        active: true,
        tick() {
          if (!handle.active) return false;
          callback();
          return true;
        }
      };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      clearIntervalCalls.push(handle);
      handle.active = false;
    }
  };
}

function loadUpdater() {
  const filename = path.join(process.cwd(), 'electron', 'updater.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const timers = createTimerHarness();
  const autoUpdater = new EventEmitter();
  let updateChecks = 0;
  autoUpdater.checkForUpdates = () => {
    updateChecks += 1;
    return Promise.resolve(null);
  };
  autoUpdater.setFeedURL = () => {};
  autoUpdater.downloadUpdate = () => Promise.resolve();
  autoUpdater.quitAndInstall = () => {};

  const ipcHandlers = new Map();
  const electron = {
    app: { getVersion: () => '1.0.0', isPackaged: true },
    dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    shell: { openExternal: () => Promise.resolve() }
  };
  const mocks = {
    electron,
    'electron-updater': { autoUpdater },
    './update-platform.cjs': { shouldForceLinuxUpdateChecks: () => true }
  };
  const context = vm.createContext({
    URL,
    console,
    process: {
      platform: 'linux',
      arch: process.arch,
      env: {},
      versions: process.versions
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  });
  const wrapper = vm.runInContext(
    `(function (require, module, exports, __filename, __dirname) { ${source}\n})`,
    context,
    { filename }
  );
  wrapper(request => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    throw new Error(`Unexpected CommonJS dependency: ${request}`);
  }, module, module.exports, filename, path.dirname(filename));

  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: () => {} }
  };
  const init = () => module.exports.initAutoUpdater(mainWindow, {
    validateSender: () => true
  });

  return {
    ...module.exports,
    init,
    timers,
    updateChecks: () => updateChecks
  };
}

test('stopping before the startup timer prevents the delayed update check', () => {
  const harness = loadUpdater();
  harness.init();
  const startupTimer = harness.timers.timeouts[0];
  const recurringTimer = harness.timers.intervals[0];

  harness.stopAutoUpdater();

  assert.equal(startupTimer.delay, 10000);
  assert.equal(startupTimer.run(), false);
  assert.equal(recurringTimer.tick(), false);
  assert.equal(harness.updateChecks(), 0);
  assert.deepEqual(harness.timers.clearTimeoutCalls, [startupTimer]);
  assert.deepEqual(harness.timers.clearIntervalCalls, [recurringTimer]);
});

test('a fired startup timer clears its ownership before updater stop', () => {
  const harness = loadUpdater();
  harness.init();
  const startupTimer = harness.timers.timeouts[0];
  const recurringTimer = harness.timers.intervals[0];

  assert.equal(startupTimer.run(), true);
  assert.equal(harness.updateChecks(), 1);
  harness.stopAutoUpdater();

  assert.deepEqual(
    harness.timers.clearTimeoutCalls,
    [],
    'Stop does not try to cancel an already-fired startup handle'
  );
  assert.deepEqual(harness.timers.clearIntervalCalls, [recurringTimer]);
});

test('the six-hour recurring interval continues checking until stopped', () => {
  const harness = loadUpdater();
  harness.init();
  const recurringTimer = harness.timers.intervals[0];

  assert.equal(recurringTimer.delay, 6 * 60 * 60 * 1000);
  assert.equal(recurringTimer.tick(), true);
  assert.equal(recurringTimer.tick(), true);
  assert.equal(harness.updateChecks(), 2);

  harness.stopAutoUpdater();
  assert.equal(recurringTimer.tick(), false);
  assert.equal(harness.updateChecks(), 2);
});

test('repeated updater stop is safe and clears each owned timer only once', () => {
  const harness = loadUpdater();
  harness.init();

  harness.stopAutoUpdater();
  harness.stopAutoUpdater();

  assert.equal(harness.timers.clearTimeoutCalls.length, 1);
  assert.equal(harness.timers.clearIntervalCalls.length, 1);
  assert.equal(harness.updateChecks(), 0);
});

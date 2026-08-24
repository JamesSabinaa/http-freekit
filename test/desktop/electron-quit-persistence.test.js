import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
  DEFAULT_RENDERER_PREPARE_TIMEOUT_MS,
  PREPARE_RENDERER_FOR_QUIT_SCRIPT,
  RENDERER_PREPARE_UNAVAILABLE,
  prepareRendererForQuit,
  runQuitCleanup
} = require('../../electron/quit-cleanup.cjs');
const {
  DEFAULT_SHUTDOWN_DEADLINE_MS
} = require('../../electron/server-shutdown.cjs');

function createWindow(executeJavaScript, calls = []) {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy() {
      calls.push('destroy-window');
      destroyed = true;
    },
    webContents: {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      executeJavaScript
    }
  };
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    }
  };
}

test('an explicit renderer cancellation aborts Quit before any destructive cleanup', async () => {
  const calls = [];
  const mainWindow = createWindow(async script => {
    calls.push('prepare-renderer');
    assert.match(script, /prepareSendTabPersistenceForQuit/);
    return false;
  }, calls);

  const shouldQuit = await runQuitCleanup({
    mainWindow,
    onPrepared: () => calls.push('mark-shutdown'),
    relaunch: () => calls.push('relaunch'),
    stopAutoUpdater: () => calls.push('stop-updater'),
    destroyTray: () => calls.push('destroy-tray'),
    shutdownServer: async () => calls.push('shutdown-server')
  });

  assert.equal(shouldQuit, false);
  assert.deepEqual(calls, ['prepare-renderer']);
  assert.equal(mainWindow.isDestroyed(), false);
});

test('successful renderer persistence closes its window before backend cleanup', async () => {
  const calls = [];
  const mainWindow = createWindow(async () => {
    calls.push('prepare-renderer');
    return true;
  }, calls);

  const shouldQuit = await runQuitCleanup({
    mainWindow,
    onPrepared: () => calls.push('mark-shutdown'),
    relaunch: () => calls.push('relaunch'),
    stopAutoUpdater: () => calls.push('stop-updater'),
    destroyTray: () => calls.push('destroy-tray'),
    shutdownServer: async () => calls.push('shutdown-server')
  });

  assert.equal(shouldQuit, true);
  assert.deepEqual(calls, [
    'prepare-renderer',
    'mark-shutdown',
    'destroy-window',
    'stop-updater',
    'destroy-tray',
    'shutdown-server',
    'relaunch'
  ]);
});

test('a never-settling renderer is independently bounded before backend cleanup', async () => {
  const calls = [];
  const errors = [];
  const timers = createTimerHarness();
  const mainWindow = createWindow(() => {
    calls.push('prepare-renderer');
    return new Promise(() => {});
  }, calls);
  const logger = { error: (...args) => errors.push(args.join(' ')) };

  const cleanup = runQuitCleanup({
    mainWindow,
    onPrepared: () => calls.push('mark-shutdown'),
    stopAutoUpdater: () => calls.push('stop-updater'),
    destroyTray: () => calls.push('destroy-tray'),
    shutdownServer: async () => calls.push('shutdown-server'),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger
  });

  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].delay, DEFAULT_RENDERER_PREPARE_TIMEOUT_MS);
  assert.deepEqual(calls, ['prepare-renderer']);

  timers.timers[0].callback();

  assert.equal(await cleanup, true);
  assert.equal(timers.timers[0].cleared, true);
  assert.deepEqual(calls, [
    'prepare-renderer',
    'mark-shutdown',
    'destroy-window',
    'stop-updater',
    'destroy-tray',
    'shutdown-server'
  ]);
  assert.match(errors[0], /did not complete within 5000ms; continuing cleanup/);
  assert.equal(mainWindow.isDestroyed(), true);
});

test('settled renderer preparation cancels its independent timeout', async () => {
  const timers = createTimerHarness();
  const mainWindow = createWindow(async () => true);

  assert.equal(await prepareRendererForQuit(mainWindow, console, {
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  }), true);
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test('renderer execution failures fail open into ordered backend cleanup', async () => {
  const calls = [];
  const errors = [];
  const timers = createTimerHarness();
  let rejectExecution;
  const mainWindow = createWindow(() => {
    calls.push('prepare-renderer');
    return new Promise((_resolve, reject) => { rejectExecution = reject; });
  }, calls);
  const logger = {
    error: (...args) => {
      calls.push('log-error');
      errors.push(args.join(' '));
    }
  };

  const cleanup = runQuitCleanup({
    mainWindow,
    onPrepared: () => calls.push('mark-shutdown'),
    stopAutoUpdater: () => calls.push('stop-updater'),
    destroyTray: () => calls.push('destroy-tray'),
    shutdownServer: async () => calls.push('shutdown-server'),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger
  });

  assert.equal(timers.timers.length, 1);
  assert.deepEqual(calls, ['prepare-renderer']);

  rejectExecution(new Error('renderer unavailable'));

  assert.equal(await cleanup, true);
  assert.equal(timers.timers[0].cleared, true);
  assert.deepEqual(calls, [
    'prepare-renderer',
    'log-error',
    'mark-shutdown',
    'destroy-window',
    'stop-updater',
    'destroy-tray',
    'shutdown-server'
  ]);
  assert.match(errors[0], /continuing cleanup: renderer unavailable/);
  assert.equal(mainWindow.isDestroyed(), true);
});

test('backend cleanup failure rejects Quit instead of reporting completion', async () => {
  const calls = [];
  const errors = [];
  const mainWindow = createWindow(async () => true, calls);

  await assert.rejects(runQuitCleanup({
    mainWindow,
    onPrepared: () => calls.push('mark-shutdown'),
    stopAutoUpdater: () => calls.push('stop-updater'),
    destroyTray: () => calls.push('destroy-tray'),
    shutdownServer: async () => { throw new Error('cleanup remains pending'); },
    logger: { error: (...args) => errors.push(args.join(' ')) }
  }), /cleanup remains pending/);

  assert.equal(mainWindow.isDestroyed(), true);
  assert.deepEqual(calls, [
    'mark-shutdown',
    'destroy-window',
    'stop-updater',
    'destroy-tray'
  ]);
  assert.match(errors[0], /Server shutdown failed: cleanup remains pending/);
});

test('a missing renderer preparation helper fails open without becoming an explicit veto', async () => {
  assert.equal(
    vm.runInNewContext(PREPARE_RENDERER_FOR_QUIT_SCRIPT, {}),
    RENDERER_PREPARE_UNAVAILABLE
  );
  assert.equal(
    vm.runInNewContext(PREPARE_RENDERER_FOR_QUIT_SCRIPT, {
      prepareRendererForQuit: () => false
    }),
    false,
    'an available helper must retain its explicit veto'
  );

  const errors = [];
  const mainWindow = createWindow(async () => RENDERER_PREPARE_UNAVAILABLE);
  const prepared = await prepareRendererForQuit(mainWindow, {
    error: (...args) => errors.push(args.join(' '))
  });

  assert.equal(prepared, true);
  assert.match(errors[0], /helper is unavailable; continuing cleanup/i);
});

test('renderer preflight keeps its five-second bound separate from backend shutdown', () => {
  assert.equal(DEFAULT_RENDERER_PREPARE_TIMEOUT_MS, 5_000);
  assert.equal(DEFAULT_SHUTDOWN_DEADLINE_MS, 30_000);
  assert.notEqual(DEFAULT_RENDERER_PREPARE_TIMEOUT_MS, DEFAULT_SHUTDOWN_DEADLINE_MS);
});

test('a loading but interactive renderer must still pass persistence preflight', async () => {
  let executeCalls = 0;
  const mainWindow = createWindow(async () => {
    executeCalls++;
    return false;
  });
  mainWindow.webContents.isLoadingMainFrame = () => true;

  assert.equal(await prepareRendererForQuit(mainWindow), false);
  assert.equal(executeCalls, 1);
  assert.equal(mainWindow.isDestroyed(), false);
});

test('renderer exposes the synchronous Send journal preflight to Electron', () => {
  const appSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'ui', 'app.js'),
    'utf8'
  );
  assert.match(
    appSource,
    /window\.prepareSendTabPersistenceForQuit = persistActiveSendTabBeforeUnload;/
  );
});

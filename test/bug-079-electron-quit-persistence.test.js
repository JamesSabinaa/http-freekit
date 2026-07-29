import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  prepareRendererForQuit,
  runQuitCleanup
} = require('../electron/quit-cleanup.cjs');

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

test('failed renderer persistence aborts Quit before any destructive cleanup', async () => {
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
    'relaunch',
    'stop-updater',
    'destroy-tray',
    'shutdown-server'
  ]);
});

test('renderer execution failures keep the application and backend alive', async () => {
  const errors = [];
  const mainWindow = createWindow(async () => {
    throw new Error('renderer unavailable');
  });
  const logger = { error: (...args) => errors.push(args.join(' ')) };

  assert.equal(await prepareRendererForQuit(mainWindow, logger), false);
  assert.match(errors[0], /renderer unavailable/);
  assert.equal(mainWindow.isDestroyed(), false);
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

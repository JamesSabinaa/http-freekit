import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
  UNSAVED_CHANGES_DIALOG,
  installUnloadConfirmation
} = require('../../electron/unload-confirmation.cjs');

function createUnloadHarness({ response = 1, prepared = false, allowUnload = false, throwDialog = false } = {}) {
  const webContents = new EventEmitter();
  const dialogCalls = [];
  const errors = [];
  let canceledCalls = 0;
  const mainWindow = { webContents };
  installUnloadConfirmation(mainWindow, {
    dialog: {
      showMessageBoxSync(...args) {
        dialogCalls.push(args);
        if (throwDialog) throw new Error('dialog unavailable');
        return response;
      }
    },
    // A completed renderer preflight must not become a long-lived unload
    // bypass while Squirrel.Mac is still waiting to begin its native quit.
    shouldAllowPreparedUnload: () => prepared,
    shouldAllowUnload: () => allowUnload,
    onUnloadCanceled: () => { canceledCalls++; },
    logger: { error: (...args) => errors.push(args.join(' ')) }
  });
  let preventCalls = 0;
  webContents.emit('will-prevent-unload', {
    preventDefault() { preventCalls++; }
  });
  return { canceledCalls, dialogCalls, errors, mainWindow, preventCalls };
}

test('Electron keeps the page when Stay is selected', () => {
  const result = createUnloadHarness({ response: 1 });

  assert.equal(result.preventCalls, 0);
  assert.equal(result.canceledCalls, 1);
  assert.equal(result.dialogCalls.length, 1);
  assert.equal(result.dialogCalls[0][0], result.mainWindow);
  assert.deepEqual(result.dialogCalls[0][1], UNSAVED_CHANGES_DIALOG);
  assert.equal(UNSAVED_CHANGES_DIALOG.defaultId, 1);
  assert.equal(UNSAVED_CHANGES_DIALOG.cancelId, 1);
});

test('Electron permits the unload only when Leave is selected', () => {
  const result = createUnloadHarness({ response: 0 });

  assert.equal(result.preventCalls, 1);
  assert.equal(result.canceledCalls, 0);
  assert.equal(result.dialogCalls.length, 1);
});

test('a completed updater preflight does not bypass a later native unload confirmation', () => {
  const result = createUnloadHarness({ prepared: true });

  assert.equal(result.preventCalls, 0);
  assert.equal(result.canceledCalls, 1);
  assert.equal(result.dialogCalls.length, 1);
});

test('an irrevocable native updater handoff bypasses the duplicate prompt', () => {
  const result = createUnloadHarness({ allowUnload: true });

  assert.equal(result.preventCalls, 1);
  assert.equal(result.canceledCalls, 0);
  assert.equal(result.dialogCalls.length, 0);
});

test('native dialog failures fail closed and are reported', () => {
  const result = createUnloadHarness({ throwDialog: true });

  assert.equal(result.preventCalls, 0);
  assert.equal(result.canceledCalls, 1);
  assert.match(result.errors[0], /dialog unavailable/);
});

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function loadUpdater({
  prepareResult = true,
  prepareError = null,
  prepareOperation = null,
  quitOperation = null
} = {}) {
  const filename = path.join(process.cwd(), 'electron', 'updater.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const autoUpdater = new EventEmitter();
  let quitCalls = 0;
  let prepareCalls = 0;
  let preparationFailureCalls = 0;
  autoUpdater.checkForUpdates = () => Promise.resolve(null);
  autoUpdater.downloadUpdate = () => Promise.resolve();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.quitAndInstall = () => {
    quitCalls++;
    if (quitOperation) quitOperation(autoUpdater, quitCalls);
  };
  const ipcHandlers = new Map();
  const statuses = [];
  const electron = {
    app: { getVersion: () => '1.0.0', isPackaged: true },
    dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
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
    clearTimeout: () => {},
    setInterval: () => ({}),
    clearInterval: () => {}
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
    webContents: { send: (_channel, data) => statuses.push(data) }
  };
  module.exports.initAutoUpdater(mainWindow, {
    validateSender: () => true,
    prepareForInstall: async () => {
      prepareCalls++;
      if (prepareError) throw prepareError;
      if (prepareOperation) return prepareOperation();
      return prepareResult;
    },
    onInstallPreparationFailed: () => { preparationFailureCalls++; }
  });
  return {
    autoUpdater,
    cancelInstall: module.exports.cancelUpdateInstall,
    install: ipcHandlers.get('updater-install'),
    statuses,
    get prepareCalls() { return prepareCalls; },
    get preparationFailureCalls() { return preparationFailureCalls; },
    get quitCalls() { return quitCalls; }
  };
}

test('Restart to install runs renderer preflight before invoking the updater', async () => {
  const accepted = loadUpdater();
  const acceptedResult = await accepted.install({});
  assert.equal(accepted.prepareCalls, 1);
  assert.equal(accepted.quitCalls, 1);
  assert.equal(acceptedResult.started, true);
  assert.equal(acceptedResult.inProgress, true);

  const canceled = loadUpdater({ prepareResult: false });
  const canceledResult = await canceled.install({});
  assert.equal(canceled.prepareCalls, 1);
  assert.equal(canceled.quitCalls, 0);
  assert.equal(canceledResult.started, false);
  assert.equal(canceledResult.inProgress, false);
});

test('Restart to install owns a single preflight and updater handoff', async () => {
  const pending = deferred();
  const updater = loadUpdater({ prepareOperation: () => pending.promise });

  const firstInstall = updater.install({});
  const duplicateResult = await updater.install({});

  assert.equal(updater.prepareCalls, 1);
  assert.equal(updater.quitCalls, 0);
  assert.equal(duplicateResult.started, false);
  assert.equal(duplicateResult.inProgress, true);

  pending.resolve(true);
  const firstResult = await firstInstall;
  assert.equal(firstResult.started, true);
  assert.equal(updater.quitCalls, 1);

  const delayedHandoffDuplicate = await updater.install({});
  assert.equal(delayedHandoffDuplicate.started, false);
  assert.equal(delayedHandoffDuplicate.inProgress, true);
  assert.equal(updater.prepareCalls, 1);
  assert.equal(updater.quitCalls, 1);
});

test('failed update preflight keeps the app open and reports the error', async () => {
  const failure = loadUpdater({ prepareError: new Error('renderer unavailable') });

  await failure.install({});

  assert.equal(failure.quitCalls, 0);
  assert.equal(failure.preparationFailureCalls, 1);
  assert.equal(failure.statuses.at(-1).status, 'error');
  assert.match(failure.statuses.at(-1).error, /renderer unavailable/);
});

test('an updater install error revokes the prepared-unload allowance', async () => {
  const failure = loadUpdater();

  await failure.install({});
  failure.autoUpdater.emit('error', new Error('installer launch failed'));

  assert.equal(failure.quitCalls, 1);
  assert.equal(failure.preparationFailureCalls, 1);
  assert.equal(failure.statuses.at(-1).status, 'error');

  const retryResult = await failure.install({});
  assert.equal(retryResult.started, true);
  assert.equal(failure.prepareCalls, 2);
  assert.equal(failure.quitCalls, 2);
});

test('canceling a native update close releases the pending request for retry', async () => {
  const updater = loadUpdater();

  const firstResult = await updater.install({});
  assert.equal(firstResult.started, true);
  assert.equal(updater.cancelInstall(), true);
  assert.equal(updater.cancelInstall(), false);
  assert.equal(updater.preparationFailureCalls, 1);
  assert.equal(updater.statuses.at(-1).status, 'install-canceled');

  const retryResult = await updater.install({});
  assert.equal(retryResult.started, true);
  assert.equal(updater.prepareCalls, 2);
  assert.equal(updater.quitCalls, 2);
});

test('a synchronous installer error does not report a started update', async () => {
  const updater = loadUpdater({
    quitOperation: (autoUpdater, quitCalls) => {
      if (quitCalls === 1) autoUpdater.emit('error', new Error('installer launch failed'));
    }
  });

  const failedResult = await updater.install({});
  assert.equal(failedResult.started, false);
  assert.equal(failedResult.inProgress, false);
  assert.equal(updater.preparationFailureCalls, 1);
  assert.equal(updater.statuses.at(-1).status, 'error');

  const retryResult = await updater.install({});
  assert.equal(retryResult.started, true);
  assert.equal(updater.prepareCalls, 2);
  assert.equal(updater.quitCalls, 2);
});

test('main process wires native unload confirmation and updater preparation together', () => {
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

  assert.match(mainSource, /installUnloadConfirmation\(mainWindow/);
  assert.doesNotMatch(mainSource, /shouldAllowPreparedUnload/);
  assert.match(mainSource, /shouldAllowUnload: \(\) => updateInstallQuitStarted && process\.platform !== 'darwin'/);
  assert.match(mainSource, /if \(updateInstallPrepared\) cancelUpdateInstall\(\)/);
  assert.match(mainSource, /nativeAutoUpdater\.on\('before-quit-for-update'/);
  assert.match(mainSource, /updateInstallQuitStarted = updateInstallPrepared/);
  assert.match(mainSource, /prepareForInstall: async \(\) =>/);
  assert.match(mainSource, /updateInstallPrepared = await prepareRendererForQuit\(mainWindow\)/);
  assert.match(mainSource, /prepare: updateInstallQuitStarted \? async \(\) => true : undefined/);
});

test('renderer disables Restart to install while its request is pending', () => {
  const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

  assert.match(rendererSource, /let installUpdateRequestPending = false/);
  assert.match(rendererSource, /if \(installUpdateRequestPending\) return/);
  assert.match(rendererSource, /setAttribute\('aria-disabled', pending \? 'true' : 'false'\)/);
  assert.match(rendererSource, /await window\.electronApi\.installUpdate\(\)/);
  assert.match(rendererSource, /case 'install-canceled':/);
  assert.match(rendererSource, /case 'check-deferred':/);
  assert.match(rendererSource, /Update check queued until the current update action finishes/);
});

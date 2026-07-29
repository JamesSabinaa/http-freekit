import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function loadUpdater(checks, {
  prepareOperation = null,
  prepareOperations = [],
  dialogOperations = []
} = {}) {
  const filename = path.join(process.cwd(), 'electron', 'updater.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const autoUpdater = new EventEmitter();
  let checkCalls = 0;
  autoUpdater.checkForUpdates = () => {
    const check = checks[checkCalls++];
    if (!check) throw new Error('unexpected update check');
    return check.promise;
  };
  let downloadCalls = 0;
  let quitCalls = 0;
  let prepareCalls = 0;
  let dialogCalls = 0;
  const pendingPreparations = [...prepareOperations];
  const pendingDialogs = [...dialogOperations];
  autoUpdater.downloadUpdate = () => {
    downloadCalls++;
    return Promise.resolve();
  };
  autoUpdater.setFeedURL = () => {};
  autoUpdater.quitAndInstall = () => { quitCalls++; };
  const ipcHandlers = new Map();
  let preparationFailureCalls = 0;
  let startupCheck = null;
  let intervalCheck = null;
  const electron = {
    app: { getVersion: () => '1.0.0', isPackaged: true },
    dialog: {
      showMessageBox: () => {
        dialogCalls++;
        return pendingDialogs.shift()?.promise || Promise.resolve({ response: 1 });
      }
    },
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
    setTimeout: callback => { startupCheck = callback; return {}; },
    clearTimeout: () => {},
    setInterval: callback => { intervalCheck = callback; return {}; },
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
  const statuses = [];
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (_channel, status) => statuses.push(status) }
  };
  const initOptions = {
    validateSender: () => true,
    prepareForInstall: () => {
      prepareCalls++;
      const pendingPreparation = pendingPreparations.shift();
      if (pendingPreparation) return pendingPreparation.promise;
      return prepareOperation ? prepareOperation() : Promise.resolve(true);
    },
    onInstallPreparationFailed: () => { preparationFailureCalls++; }
  };
  module.exports.initAutoUpdater(mainWindow, initOptions);
  return {
    autoUpdater,
    checkNow: () => ipcHandlers.get('updater-check-now')({}),
    install: () => ipcHandlers.get('updater-install')({}),
    reinitialize: () => module.exports.initAutoUpdater(mainWindow, initOptions),
    runIntervalCheck: () => intervalCheck(),
    runStartupCheck: () => startupCheck(),
    statuses,
    stop: module.exports.stopAutoUpdater,
    cancelInstall: module.exports.cancelUpdateInstall,
    get dialogCalls() { return dialogCalls; },
    get downloadCalls() { return downloadCalls; },
    get prepareCalls() { return prepareCalls; },
    get preparationFailureCalls() { return preparationFailureCalls; },
    get quitCalls() { return quitCalls; },
    get checkCalls() { return checkCalls; }
  };
}

test('a manual check promotes an overlapping automatic check without duplicating it', async () => {
  const check = deferred();
  const updater = loadUpdater([check]);

  updater.runStartupCheck();
  updater.autoUpdater.emit('checking-for-update');
  const manual = updater.checkNow();

  assert.equal(updater.checkCalls, 1);
  assert.equal(updater.statuses.at(-1).status, 'checking');
  assert.equal(updater.statuses.at(-1).manual, true);
  updater.autoUpdater.emit('update-not-available');
  check.resolve(null);
  await manual;

  assert.equal(updater.statuses.at(-1).status, 'up-to-date');
  assert.equal(updater.statuses.at(-1).manual, true);
});

test('an automatic check cannot demote an in-flight manual check', async () => {
  const check = deferred();
  const updater = loadUpdater([check]);

  const manual = updater.checkNow();
  updater.runStartupCheck();
  updater.autoUpdater.emit('checking-for-update');
  updater.autoUpdater.emit('update-not-available');
  check.resolve(null);
  await manual;

  assert.equal(updater.checkCalls, 1);
  assert.equal(updater.statuses.at(-1).manual, true);
});

test('a promoted rejected check reports one manual error', async () => {
  const check = deferred();
  const updater = loadUpdater([check]);

  updater.runStartupCheck();
  const manual = updater.checkNow();
  check.reject(new Error('offline'));
  await manual;

  const errors = updater.statuses.filter(status => status.status === 'error');
  assert.equal(updater.checkCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].manual, true);
  assert.match(errors[0].error, /offline/);
});

test('a request after a reported result waits and starts a fresh check', async () => {
  const first = deferred();
  const second = deferred();
  const updater = loadUpdater([first, second]);

  updater.runStartupCheck();
  updater.autoUpdater.emit('update-not-available');
  const manual = updater.checkNow();
  assert.equal(updater.checkCalls, 1);

  first.resolve(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.checkCalls, 2);
  updater.autoUpdater.emit('checking-for-update');
  updater.autoUpdater.emit('update-not-available');
  second.resolve(null);
  await manual;

  assert.equal(updater.statuses.at(-1).status, 'up-to-date');
  assert.equal(updater.statuses.at(-1).manual, true);
});

test('separate later automatic checks do not inherit manual attribution', async () => {
  const first = deferred();
  const second = deferred();
  const updater = loadUpdater([first, second]);

  const manual = updater.checkNow();
  updater.autoUpdater.emit('update-not-available');
  first.resolve(null);
  await manual;

  updater.runIntervalCheck();
  updater.autoUpdater.emit('update-not-available');
  second.resolve(null);
  await second.promise;

  assert.equal(updater.checkCalls, 2);
  assert.equal(updater.statuses.at(-1).manual, false);
});

test('check and installer errors retain separate serialized owners', async () => {
  const check = deferred();
  const updater = loadUpdater([check]);

  updater.runStartupCheck();
  const install = updater.install();
  assert.equal(updater.prepareCalls, 0, 'install waits for the active updater check');

  const checkError = new Error('automatic check failed');
  updater.autoUpdater.emit('error', checkError);
  check.reject(checkError);
  const installResult = await install;
  assert.equal(installResult.started, true);
  assert.equal(updater.prepareCalls, 1);
  assert.equal(updater.quitCalls, 1);

  updater.autoUpdater.emit('error', new Error('installer launch failed'));

  const errors = updater.statuses.filter(status => status.status === 'error');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].manual, false);
  assert.match(errors[0].error, /automatic check failed/);
  assert.equal(errors[1].manual, true);
  assert.match(errors[1].error, /installer launch failed/);
  assert.equal(updater.preparationFailureCalls, 1);
  assert.equal(updater.cancelInstall(), false);
});

test('late install preflight settlement cannot release a new lifecycle request', async t => {
  for (const lateResult of ['resolve', 'reject']) {
    await t.test(lateResult, async () => {
      const oldPreparation = deferred();
      const newPreparation = deferred();
      const updater = loadUpdater([], {
        prepareOperations: [oldPreparation, newPreparation]
      });

      const oldInstall = updater.install();
      assert.equal(updater.prepareCalls, 1);
      updater.reinitialize();
      const newInstall = updater.install();
      assert.equal(updater.prepareCalls, 2);

      if (lateResult === 'resolve') oldPreparation.resolve(false);
      else oldPreparation.reject(new Error('late old preflight failure'));
      const oldResult = await oldInstall;
      assert.equal(oldResult.started, false);
      assert.equal(updater.preparationFailureCalls, 0);
      assert.equal(updater.statuses.some(status => status.error === 'late old preflight failure'), false);

      newPreparation.resolve(true);
      const newResult = await newInstall;
      assert.equal(newResult.started, true);
      assert.equal(updater.quitCalls, 1);
    });
  }
});

test('stop and re-init replace a pending update prompt without stale side effects', async () => {
  const oldCheck = deferred();
  const newCheck = deferred();
  const oldDialog = deferred();
  const newDialog = deferred();
  const updater = loadUpdater([oldCheck, newCheck], {
    dialogOperations: [oldDialog, newDialog]
  });

  updater.runStartupCheck();
  updater.autoUpdater.emit('update-available', { version: '2.0.0' });
  assert.equal(updater.dialogCalls, 1);
  oldCheck.resolve(null);
  await oldCheck.promise;

  updater.reinitialize();
  const newManualCheck = updater.checkNow();
  updater.autoUpdater.emit('update-available', { version: '3.0.0' });
  assert.equal(updater.dialogCalls, 2);
  newCheck.resolve(null);

  oldDialog.resolve({ response: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.downloadCalls, 0);
  assert.equal(updater.statuses.some(status => status.version === '2.0.0' && status.status === 'download-started'), false);

  newDialog.resolve({ response: 1 });
  await newManualCheck;
  await new Promise(resolve => setImmediate(resolve));
  const dismissals = updater.statuses.filter(status => status.status === 'update-dismissed');
  assert.equal(dismissals.length, 1);
  assert.equal(dismissals[0].version, '3.0.0');
  assert.equal(dismissals[0].manual, true);
});

test('stop cancels a check queued in the result-settlement gap', async () => {
  const first = deferred();
  const unexpectedSecond = deferred();
  const updater = loadUpdater([first, unexpectedSecond]);

  updater.runStartupCheck();
  updater.autoUpdater.emit('update-not-available');
  const queued = updater.checkNow();
  updater.stop();
  first.resolve(null);
  await queued;

  assert.equal(updater.checkCalls, 1);
});

test('stop and re-init replace listeners and isolate late check settlement', async () => {
  const oldCheck = deferred();
  const newCheck = deferred();
  const updater = loadUpdater([oldCheck, newCheck]);

  updater.runStartupCheck();
  assert.equal(updater.autoUpdater.listenerCount('update-not-available'), 1);
  updater.stop();
  assert.equal(updater.autoUpdater.listenerCount('update-not-available'), 0);
  updater.reinitialize();
  assert.equal(updater.autoUpdater.listenerCount('update-not-available'), 1);

  const manual = updater.checkNow();
  oldCheck.reject(new Error('late old failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.statuses.some(status => status.error === 'late old failure'), false);

  updater.autoUpdater.emit('update-not-available');
  newCheck.resolve(null);
  await manual;
  assert.equal(updater.statuses.at(-1).status, 'up-to-date');
  assert.equal(updater.statuses.at(-1).manual, true);
});

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
} = require('../electron/unload-confirmation.cjs');

function createUnloadHarness({ response = 1, prepared = false, throwDialog = false } = {}) {
  const webContents = new EventEmitter();
  const dialogCalls = [];
  const errors = [];
  const mainWindow = { webContents };
  installUnloadConfirmation(mainWindow, {
    dialog: {
      showMessageBoxSync(...args) {
        dialogCalls.push(args);
        if (throwDialog) throw new Error('dialog unavailable');
        return response;
      }
    },
    shouldAllowPreparedUnload: () => prepared,
    logger: { error: (...args) => errors.push(args.join(' ')) }
  });
  let preventCalls = 0;
  webContents.emit('will-prevent-unload', {
    preventDefault() { preventCalls++; }
  });
  return { dialogCalls, errors, mainWindow, preventCalls };
}

test('Electron keeps the page when Stay is selected', () => {
  const result = createUnloadHarness({ response: 1 });

  assert.equal(result.preventCalls, 0);
  assert.equal(result.dialogCalls.length, 1);
  assert.equal(result.dialogCalls[0][0], result.mainWindow);
  assert.deepEqual(result.dialogCalls[0][1], UNSAVED_CHANGES_DIALOG);
  assert.equal(UNSAVED_CHANGES_DIALOG.defaultId, 1);
  assert.equal(UNSAVED_CHANGES_DIALOG.cancelId, 1);
});

test('Electron permits the unload only when Leave is selected', () => {
  const result = createUnloadHarness({ response: 0 });

  assert.equal(result.preventCalls, 1);
  assert.equal(result.dialogCalls.length, 1);
});

test('a completed updater preflight permits its platform-specific unload without a second prompt', () => {
  const result = createUnloadHarness({ prepared: true });

  assert.equal(result.preventCalls, 1);
  assert.deepEqual(result.dialogCalls, []);
});

test('native dialog failures fail closed and are reported', () => {
  const result = createUnloadHarness({ throwDialog: true });

  assert.equal(result.preventCalls, 0);
  assert.match(result.errors[0], /dialog unavailable/);
});

function loadUpdater({ prepareResult = true, prepareError = null } = {}) {
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
  autoUpdater.quitAndInstall = () => { quitCalls++; };
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
      return prepareResult;
    },
    onInstallPreparationFailed: () => { preparationFailureCalls++; }
  });
  return {
    autoUpdater,
    install: ipcHandlers.get('updater-install'),
    statuses,
    get prepareCalls() { return prepareCalls; },
    get preparationFailureCalls() { return preparationFailureCalls; },
    get quitCalls() { return quitCalls; }
  };
}

test('Restart to install runs renderer preflight before invoking the updater', async () => {
  const accepted = loadUpdater();
  await accepted.install({});
  assert.equal(accepted.prepareCalls, 1);
  assert.equal(accepted.quitCalls, 1);

  const canceled = loadUpdater({ prepareResult: false });
  await canceled.install({});
  assert.equal(canceled.prepareCalls, 1);
  assert.equal(canceled.quitCalls, 0);
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
});

test('main process wires native unload confirmation and updater preparation together', () => {
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

  assert.match(mainSource, /installUnloadConfirmation\(mainWindow/);
  assert.match(mainSource, /shouldAllowPreparedUnload: \(\) => updateInstallPrepared/);
  assert.match(mainSource, /prepareForInstall: async \(\) =>/);
  assert.match(mainSource, /updateInstallPrepared = await prepareRendererForQuit\(mainWindow\)/);
  assert.match(mainSource, /prepare: updateInstallPrepared \? async \(\) => true : undefined/);
});

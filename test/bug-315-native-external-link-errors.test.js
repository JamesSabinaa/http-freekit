import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadCommonJs(relativePath, mocks, platform = 'linux') {
  const filename = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({
    URL,
    console,
    process: {
      platform,
      arch: process.arch,
      env: {},
      versions: process.versions
    },
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {}
  });
  const wrapper = vm.runInContext(
    `(function (require, module, exports, __filename, __dirname) { ${source}\n})`,
    context,
    { filename }
  );
  const localRequire = request => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    throw new Error(`Unexpected CommonJS dependency: ${request}`);
  };
  wrapper(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

async function settlePromises() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

async function withUnhandledCapture(action) {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await action();
    await settlePromises();
    return unhandled;
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMenuHarness({ openExternal, showMessageBox, mainWindow } = {}) {
  let template;
  const shell = { openExternal: openExternal || (() => Promise.resolve()) };
  const dialogCalls = [];
  const dialog = {
    showMessageBox: (...args) => {
      dialogCalls.push(args);
      return showMessageBox ? showMessageBox(...args) : Promise.resolve({ response: 0 });
    }
  };
  const electron = {
    Menu: {
      buildFromTemplate: value => {
        template = value;
        return { template: value };
      }
    },
    shell,
    dialog,
    app: { name: 'HTTP FreeKit', getVersion: () => '1.0.0' }
  };
  const window = mainWindow || {
    isDestroyed: () => false,
    webContents: { reload() {} },
    close() {}
  };
  const { buildAppMenu } = loadCommonJs('electron/menu.cjs', { electron }, 'linux');
  buildAppMenu(window);
  const helpMenu = template.find(item => item.label === 'Help');
  const documentation = helpMenu.submenu.find(item => item.label === 'Documentation');
  return { documentation, dialogCalls, mainWindow: window };
}

test('Documentation opens successfully without showing an error dialog', async () => {
  const opened = [];
  const harness = createMenuHarness({
    openExternal: async url => { opened.push(url); }
  });

  const unhandled = await withUnhandledCapture(() => harness.documentation.click());

  assert.deepEqual(opened, ['https://github.com/jamessabinaa/http-freekit#readme']);
  assert.deepEqual(harness.dialogCalls, []);
  assert.deepEqual(unhandled, []);
});

test('Documentation rejection shows a native window-bound error without an unhandled rejection', async () => {
  const failure = new Error('no URL handler');
  const harness = createMenuHarness({
    openExternal: () => Promise.reject(failure)
  });

  const unhandled = await withUnhandledCapture(() => harness.documentation.click());

  assert.equal(harness.dialogCalls.length, 1);
  assert.equal(harness.dialogCalls[0][0], harness.mainWindow);
  assert.deepEqual(plain(harness.dialogCalls[0][1]), {
    type: 'error',
    title: 'Unable to Open Documentation',
    message: 'HTTP FreeKit could not open the documentation in your browser.',
    detail: failure.message
  });
  assert.deepEqual(unhandled, []);
});

test('a rejected Documentation error dialog cannot become unhandled', async () => {
  const harness = createMenuHarness({
    openExternal: () => Promise.reject(new Error('open failed')),
    showMessageBox: () => Promise.reject(new Error('dialog failed'))
  });

  const unhandled = await withUnhandledCapture(() => harness.documentation.click());

  assert.equal(harness.dialogCalls.length, 1);
  assert.deepEqual(unhandled, []);
});

function createUpdaterHarness({ dialogResponses, openExternal }) {
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = () => Promise.resolve(null);
  autoUpdater.downloadUpdate = () => Promise.resolve();
  autoUpdater.getFeedURL = () => '';
  autoUpdater.setFeedURL = () => {};
  autoUpdater.quitAndInstall = () => {};

  const statuses = [];
  const opened = [];
  const dialogCalls = [];
  const ipcHandlers = new Map();
  const electron = {
    app: { getVersion: () => '1.0.0', isPackaged: true },
    dialog: {
      showMessageBox: async (...args) => {
        dialogCalls.push(args);
        return dialogResponses.shift();
      }
    },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    shell: {
      openExternal: url => {
        opened.push(url);
        return openExternal(url);
      }
    }
  };
  const updaterModule = loadCommonJs('electron/updater.cjs', {
    electron,
    'electron-updater': { autoUpdater },
    './update-platform.cjs': { shouldForceLinuxUpdateChecks: () => true }
  }, 'linux');
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, data) => statuses.push({ channel, data }) }
  };
  updaterModule.initAutoUpdater(mainWindow, { validateSender: () => true });
  return { autoUpdater, dialogCalls, ipcHandlers, opened, statuses, ...updaterModule };
}

function updaterStatuses(harness) {
  return harness.statuses.map(entry => entry.data);
}

test('Linux updater awaits a successful external open and resets its prompt state', async () => {
  const harness = createUpdaterHarness({
    dialogResponses: [{ response: 0 }, { response: 0 }],
    openExternal: () => Promise.resolve()
  });

  const unhandled = await withUnhandledCapture(async () => {
    harness.autoUpdater.emit('update-available', {
      version: '2.0.0',
      releaseNotes: 'https://downloads.example/2.0.0'
    });
    await settlePromises();
    harness.autoUpdater.emit('update-available', {
      version: '2.0.1',
      releaseNotes: 'https://downloads.example/2.0.1'
    });
  });

  assert.deepEqual(harness.opened, [
    'https://downloads.example/2.0.0',
    'https://downloads.example/2.0.1'
  ]);
  assert.equal(harness.dialogCalls.length, 2, 'the completed first prompt does not block the next update');
  assert.equal(updaterStatuses(harness).some(status => status.status === 'error'), false);
  assert.deepEqual(unhandled, []);
  harness.stopAutoUpdater();
});

test('Linux updater reports external-open rejection and resets its prompt state', async () => {
  let openAttempt = 0;
  const harness = createUpdaterHarness({
    dialogResponses: [{ response: 0 }, { response: 1 }],
    openExternal: () => {
      openAttempt++;
      return Promise.reject(new Error('download page blocked'));
    }
  });

  const unhandled = await withUnhandledCapture(async () => {
    harness.autoUpdater.emit('update-available', {
      version: '3.0.0',
      releaseNotes: 'https://downloads.example/3.0.0'
    });
    await settlePromises();
    harness.autoUpdater.emit('update-available', {
      version: '3.0.1',
      releaseNotes: 'https://downloads.example/3.0.1'
    });
  });

  const statuses = updaterStatuses(harness);
  assert.equal(openAttempt, 1);
  assert.equal(harness.dialogCalls.length, 2, 'finally releases the prompt after openExternal rejects');
  assert.deepEqual(plain(statuses.find(status => status.status === 'error')), {
    status: 'error',
    error: 'download page blocked',
    manual: false
  });
  assert.deepEqual(plain(statuses.at(-1)), {
    status: 'update-dismissed',
    version: '3.0.1',
    manual: false
  });
  assert.deepEqual(unhandled, []);
  harness.stopAutoUpdater();
});

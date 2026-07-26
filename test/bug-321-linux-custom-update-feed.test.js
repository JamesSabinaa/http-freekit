import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DEFAULT_DOWNLOAD_URL = 'https://github.com/jamessabinaa/http-freekit/releases/latest';
const DEPRECATED_GETTER_TEXT = 'Please use autoUpdater.setFeedURL() instead';

function loadUpdater({ updateUrl, dialogResponse = 0 } = {}) {
  const filename = path.join(process.cwd(), 'electron', 'updater.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const autoUpdater = new EventEmitter();
  const configuredFeeds = [];
  const dialogCalls = [];
  const openedUrls = [];
  const statuses = [];
  const ipcHandlers = new Map();
  let feedGetterCalls = 0;

  autoUpdater.checkForUpdates = () => Promise.resolve(null);
  autoUpdater.downloadUpdate = () => Promise.resolve();
  autoUpdater.getFeedURL = () => {
    feedGetterCalls += 1;
    return DEPRECATED_GETTER_TEXT;
  };
  autoUpdater.setFeedURL = value => configuredFeeds.push(value);
  autoUpdater.quitAndInstall = () => {};

  const electron = {
    app: { getVersion: () => '1.0.0', isPackaged: true },
    dialog: {
      showMessageBox: async (...args) => {
        dialogCalls.push(args);
        return { response: dialogResponse };
      }
    },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    shell: {
      openExternal: async url => { openedUrls.push(url); }
    }
  };
  const mocks = {
    electron,
    'electron-updater': { autoUpdater },
    './update-platform.cjs': { shouldForceLinuxUpdateChecks: () => true }
  };
  const env = updateUrl === undefined ? {} : { UPDATE_URL: updateUrl };
  const context = vm.createContext({
    URL,
    console,
    process: {
      platform: 'linux',
      arch: process.arch,
      env,
      versions: process.versions
    },
    setTimeout: () => ({ unref() {} }),
    setInterval: () => ({ unref() {} }),
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
    webContents: {
      send: (channel, data) => statuses.push({ channel, data })
    }
  };
  module.exports.initAutoUpdater(mainWindow, { validateSender: () => true });

  return {
    autoUpdater,
    configuredFeeds,
    dialogCalls,
    feedGetterCalls: () => feedGetterCalls,
    ipcHandlers,
    openedUrls,
    statuses,
    stop: module.exports.stopAutoUpdater
  };
}

async function settlePromises() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

function availableStatus(harness) {
  return harness.statuses
    .map(entry => entry.data)
    .find(status => status.status === 'update-available-linux');
}

test('a generic custom feed drives the same manual renderer status and native prompt URL', async () => {
  const feedUrl = 'https://updates.example.test/linux/latest.yml?channel=stable';
  const harness = loadUpdater({ updateUrl: `  ${feedUrl}  ` });
  const sender = {};

  await harness.ipcHandlers.get('updater-check-now')(sender);
  harness.autoUpdater.emit('update-available', {
    version: '2.1.0',
    releaseNotes: 'Ordinary release notes, not a URL'
  });
  await settlePromises();

  const status = availableStatus(harness);
  assert.deepEqual(harness.configuredFeeds, [feedUrl]);
  assert.equal(status.url, feedUrl);
  assert.equal(status.manual, true);
  assert.deepEqual(harness.openedUrls, [status.url]);
  assert.equal(harness.dialogCalls.length, 1);
  assert.match(harness.dialogCalls[0][1].detail, /release page/);
  assert.doesNotMatch(harness.dialogCalls[0][1].detail, /GitHub Releases/);
  assert.deepEqual(
    harness.ipcHandlers.get('updater-get-status')(sender),
    status
  );
  assert.equal(harness.feedGetterCalls(), 0);
  harness.stop();
});

test('custom GitHub web and API feeds resolve to their own repository releases', async t => {
  const cases = [
    {
      feed: 'https://github.com/example-owner/example-app/releases/download/v2/latest-linux.yml',
      expected: 'https://github.com/example-owner/example-app/releases/latest'
    },
    {
      feed: 'https://api.github.com/repos/another-owner/another-app/releases/latest',
      expected: 'https://github.com/another-owner/another-app/releases/latest'
    }
  ];

  for (const { feed, expected } of cases) {
    await t.test(feed, async () => {
      const harness = loadUpdater({ updateUrl: feed });
      harness.autoUpdater.emit('update-available', {
        version: '2.2.0',
        releaseNotes: 'Bug fixes'
      });
      await settlePromises();

      assert.equal(availableStatus(harness).url, expected);
      assert.deepEqual(harness.openedUrls, [expected]);
      assert.equal(harness.feedGetterCalls(), 0);
      harness.stop();
    });
  }
});

test('a safe release-notes URL takes precedence and unsafe notes fall back to the custom provider', async () => {
  const feedUrl = 'https://updates.example.test/stable/latest.yml';
  const releaseNotesUrl = 'https://downloads.example.test/releases/3.0.0';
  const harness = loadUpdater({ updateUrl: feedUrl });

  harness.autoUpdater.emit('update-available', {
    version: '3.0.0',
    releaseNotes: ` ${releaseNotesUrl} `
  });
  await settlePromises();
  assert.equal(availableStatus(harness).url, releaseNotesUrl);
  assert.deepEqual(harness.openedUrls, [releaseNotesUrl]);
  harness.stop();

  const unsafeHarness = loadUpdater({ updateUrl: feedUrl });
  unsafeHarness.autoUpdater.emit('update-available', {
    version: '3.0.1',
    releaseNotes: 'javascript:alert(1)'
  });
  await settlePromises();
  assert.equal(availableStatus(unsafeHarness).url, feedUrl);
  assert.deepEqual(unsafeHarness.openedUrls, [feedUrl]);
  unsafeHarness.stop();
});

test('malformed and non-web custom sources are ignored without exposing getter text', async t => {
  for (const updateUrl of ['not a URL', 'file:///tmp/latest.yml', 'javascript:alert(1)']) {
    await t.test(updateUrl, async () => {
      const harness = loadUpdater({ updateUrl });
      harness.autoUpdater.emit('update-available', {
        version: '4.0.0',
        releaseNotes: 'No web link here'
      });
      await settlePromises();

      const status = availableStatus(harness);
      assert.deepEqual(harness.configuredFeeds, []);
      assert.equal(status.url, DEFAULT_DOWNLOAD_URL);
      assert.deepEqual(harness.openedUrls, [DEFAULT_DOWNLOAD_URL]);
      assert.equal(harness.feedGetterCalls(), 0);
      assert.doesNotMatch(JSON.stringify(harness.statuses), new RegExp(DEPRECATED_GETTER_TEXT));
      harness.stop();
    });
  }
});

test('the project release page remains the default when no custom source exists', async () => {
  const harness = loadUpdater();
  harness.autoUpdater.emit('update-available', {
    version: '5.0.0',
    releaseNotes: null
  });
  await settlePromises();

  assert.equal(availableStatus(harness).url, DEFAULT_DOWNLOAD_URL);
  assert.deepEqual(harness.openedUrls, [DEFAULT_DOWNLOAD_URL]);
  assert.equal(harness.feedGetterCalls(), 0);
  harness.stop();
});

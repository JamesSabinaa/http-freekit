import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DEFAULT_DOWNLOAD_URL = 'https://github.com/jamessabinaa/http-freekit/releases/latest';
const DEPRECATED_GETTER_TEXT = 'Please use autoUpdater.setFeedURL() instead';

function loadUpdater({ updateUrl, downloadUrl, dialogResponse = 0 } = {}) {
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
  const env = {};
  if (updateUrl !== undefined) env.UPDATE_URL = updateUrl;
  if (downloadUrl !== undefined) env.UPDATE_DOWNLOAD_URL = downloadUrl;
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
    clearTimeout: () => {},
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

test('a generic custom feed is never exposed as a Linux download page', async () => {
  const feedUrl = 'https://updates.example.test/linux/latest.yml?channel=stable#download';
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
  assert.equal(status.url, null);
  assert.equal(status.manual, true);
  assert.deepEqual(harness.openedUrls, []);
  assert.equal(harness.dialogCalls.length, 1);
  assert.match(harness.dialogCalls[0][1].detail, /UPDATE_DOWNLOAD_URL/);
  assert.deepEqual(Array.from(harness.dialogCalls[0][1].buttons), ['OK']);
  assert.deepEqual(
    harness.ipcHandlers.get('updater-get-status')(sender),
    status
  );
  assert.equal(harness.feedGetterCalls(), 0);
  harness.stop();
});

test('a separate custom Linux download URL drives status and native navigation', async () => {
  const feedUrl = 'https://updates.example.test/linux/latest.yml';
  const downloadUrl = 'https://downloads.example.test/http-freekit/linux';
  const harness = loadUpdater({ updateUrl: feedUrl, downloadUrl: `  ${downloadUrl}  ` });

  await harness.ipcHandlers.get('updater-check-now')({});
  harness.autoUpdater.emit('update-available', {
    version: '2.1.1',
    releaseNotes: 'Ordinary release notes, not a URL'
  });
  await settlePromises();

  assert.deepEqual(harness.configuredFeeds, [feedUrl]);
  assert.equal(availableStatus(harness).url, downloadUrl);
  assert.deepEqual(harness.openedUrls, [downloadUrl]);
  assert.match(harness.dialogCalls[0][1].detail, /release page/);
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
      await harness.ipcHandlers.get('updater-check-now')({});
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

test('a safe release-notes URL takes precedence and unsafe notes use the configured download page', async () => {
  const feedUrl = 'https://updates.example.test/stable/latest.yml';
  const downloadUrl = 'https://downloads.example.test/releases/latest';
  const releaseNotesUrl = 'http://downloads.example.test/releases/3.0.0?format=appimage#download';
  const harness = loadUpdater({ updateUrl: feedUrl, downloadUrl });

  await harness.ipcHandlers.get('updater-check-now')({});
  harness.autoUpdater.emit('update-available', {
    version: '3.0.0',
    releaseNotes: ` ${releaseNotesUrl} `
  });
  await settlePromises();
  assert.equal(availableStatus(harness).url, releaseNotesUrl);
  assert.deepEqual(harness.openedUrls, [releaseNotesUrl]);
  harness.stop();

  const unsafeHarness = loadUpdater({ updateUrl: feedUrl, downloadUrl });
  await unsafeHarness.ipcHandlers.get('updater-check-now')({});
  unsafeHarness.autoUpdater.emit('update-available', {
    version: '3.0.1',
    releaseNotes: 'javascript:alert(1)'
  });
  await settlePromises();
  assert.equal(availableStatus(unsafeHarness).url, downloadUrl);
  assert.deepEqual(unsafeHarness.openedUrls, [downloadUrl]);
  unsafeHarness.stop();
});

test('validated Linux URLs are serialized before reaching feed, status, and native link consumers', async t => {
  const quoteBearingUrl = 'https://updates.example.test/path" data-audit="present?channel=stable#download';
  const normalizedUrl = new URL(quoteBearingUrl).href;
  assert.match(normalizedUrl, /path%22%20data-audit=%22present\?channel=stable#download$/);

  await t.test('custom feed and download page', async () => {
    const feedUrl = 'https://updates.example.test/stable/latest.yml';
    const harness = loadUpdater({
      updateUrl: `  ${feedUrl}  `,
      downloadUrl: `  ${quoteBearingUrl}  `
    });
    await harness.ipcHandlers.get('updater-check-now')({});
    harness.autoUpdater.emit('update-available', {
      version: '3.1.0',
      releaseNotes: 'Release notes without a link'
    });
    await settlePromises();

    assert.deepEqual(harness.configuredFeeds, [feedUrl]);
    assert.equal(availableStatus(harness).url, normalizedUrl);
    assert.equal(harness.ipcHandlers.get('updater-get-status')({}).url, normalizedUrl);
    assert.deepEqual(harness.openedUrls, [normalizedUrl]);
    harness.stop();
  });

  await t.test('release notes', async () => {
    const feedUrl = 'https://updates.example.test/stable/latest.yml?channel=stable#metadata';
    const harness = loadUpdater({ updateUrl: feedUrl });
    await harness.ipcHandlers.get('updater-check-now')({});
    harness.autoUpdater.emit('update-available', {
      version: '3.1.1',
      releaseNotes: `  ${quoteBearingUrl}  `
    });
    await settlePromises();

    assert.deepEqual(harness.configuredFeeds, [feedUrl]);
    assert.equal(availableStatus(harness).url, normalizedUrl);
    assert.equal(harness.ipcHandlers.get('updater-get-status')({}).url, normalizedUrl);
    assert.deepEqual(harness.openedUrls, [normalizedUrl]);
    harness.stop();
  });
});

test('malformed, empty, and non-web custom feeds disable checks instead of falling back', async t => {
  for (const updateUrl of ['', 'not a URL', 'file:///tmp/latest.yml', 'javascript:alert(1)']) {
    await t.test(updateUrl, async () => {
      const harness = loadUpdater({ updateUrl });
      await harness.ipcHandlers.get('updater-check-now')({});
      harness.autoUpdater.emit('update-available', {
        version: '4.0.0',
        releaseNotes: 'No web link here'
      });
      await settlePromises();

      const status = harness.ipcHandlers.get('updater-get-status')({});
      assert.deepEqual(harness.configuredFeeds, []);
      assert.equal(status.status, 'unavailable');
      assert.equal(status.available, false);
      assert.match(status.error, /UPDATE_URL must be a non-empty HTTP\(S\) URL/);
      assert.deepEqual(harness.openedUrls, []);
      assert.deepEqual(harness.dialogCalls, []);
      assert.equal(harness.feedGetterCalls(), 0);
      assert.doesNotMatch(JSON.stringify(harness.statuses), new RegExp(DEPRECATED_GETTER_TEXT));
      harness.stop();
    });
  }
});

test('an explicit invalid Linux download page disables checks', async () => {
  const harness = loadUpdater({
    updateUrl: 'https://updates.example.test/latest.yml',
    downloadUrl: 'file:///tmp/package.AppImage'
  });

  await harness.ipcHandlers.get('updater-check-now')({});
  const status = harness.ipcHandlers.get('updater-get-status')({});

  assert.equal(status.status, 'unavailable');
  assert.match(status.error, /UPDATE_DOWNLOAD_URL must be a non-empty HTTP\(S\) URL/);
  assert.deepEqual(harness.configuredFeeds, []);
  assert.deepEqual(harness.openedUrls, []);
  harness.stop();
});

test('the project release page remains the default when no custom source exists', async () => {
  const harness = loadUpdater();
  await harness.ipcHandlers.get('updater-check-now')({});
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

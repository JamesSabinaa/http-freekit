import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `${startText} should exist`);
  assert.notEqual(end, -1, `${endText} should follow ${startText}`);
  return source.slice(start, end);
}

const recoverySource = [
  section('function showMainWindow()', 'function handleMainWindowReady'),
  section('function handleMainWindowReady', 'function reportDeepLinkError'),
  section('function reportDeepLinkError', 'function requestOpenInProxiedChrome'),
  section('function scheduleDeepLink', 'function handleDeepLink'),
  section('function handleDeepLink', 'function flushPendingDeepLinks'),
  section('function flushPendingDeepLinks', 'function shutdownServer')
].join('\n');

function createHarness({ parse, open, importHar = async () => ({ success: true }), harTarget }) {
  const calls = { errors: [], focus: 0, show: 0, opened: [], imported: [] };
  const context = {
    calls,
    parse,
    open,
    importHar,
    isHarTarget: harTarget || (url => new URL(url).pathname.toLowerCase().endsWith('.har')),
    console,
    showTrayWindow(window) {
      if (!window.isVisible()) window.show();
      window.focus();
    }
  };
  vm.runInNewContext(`
    const windowStub = {
      visible: false,
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      isVisible() { return this.visible; },
      show() { this.visible = true; calls.show++; },
      focus() { calls.focus++; }
    };
    let mainWindow = windowStub;
    let mainWindowReadyToShow = false;
    let showMainWindowWhenReady = false;
    let serverReady = true;
    let deepLinkProcessing = Promise.resolve();
    const pendingDeepLinks = [];
    const app = { isReady: () => true };
    const dialog = {
      showErrorBox(title, message) { calls.errors.push([title, message]); }
    };
    function parseOpenDeepLink(value) { return parse(value); }
    function requestOpenInProxiedChrome(url) {
      calls.opened.push(url);
      return open(url);
    }
    function requestImportHar(url) {
      calls.imported.push(url);
      return importHar(url);
    }
    ${recoverySource}
    globalThis.harness = {
      handleDeepLink,
      flushPendingDeepLinks,
      markReady(showOnReady = false) {
        handleMainWindowReady(windowStub, showOnReady);
      },
      setServerReady(value) { serverReady = value; },
      processing() { return deepLinkProcessing; },
      state() {
        return {
          ready: mainWindowReadyToShow,
          revealPending: showMainWindowWhenReady,
          pendingCount: pendingDeepLinks.length,
          visible: windowStub.visible
        };
      }
    };
  `, context);
  return { harness: context.harness, calls };
}

test('startup deep-link parse failure reveals and focuses once the hidden window is ready', () => {
  const { harness, calls } = createHarness({
    parse: () => { throw new Error('Invalid startup link'); },
    open: async () => ({ success: true })
  });

  harness.handleDeepLink('invalid', { revealWindowOnFailure: true });

  assert.equal(harness.state().revealPending, true);
  assert.equal(calls.show, 0);
  assert.equal(calls.focus, 0);
  harness.markReady(false);
  assert.equal(harness.state().visible, true);
  assert.equal(calls.show, 1);
  assert.equal(calls.focus, 1);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][1], 'Invalid startup link');
});

test('a queued reveal request takes focus when a normally visible window becomes ready', () => {
  const { harness, calls } = createHarness({
    parse: () => { throw new Error('Invalid startup link'); },
    open: async () => ({ success: true })
  });

  harness.handleDeepLink('invalid', { revealWindowOnFailure: true });
  harness.markReady(true);

  assert.equal(harness.state().visible, true);
  assert.equal(harness.state().revealPending, false);
  assert.equal(calls.show, 1);
  assert.equal(calls.focus, 1);
});

test('failed pending startup request reveals and focuses the hidden ready window', async () => {
  const { harness, calls } = createHarness({
    parse: () => 'https://example.test/failure',
    open: async () => { throw new Error('Could not open proxied Chrome'); }
  });
  harness.setServerReady(false);
  harness.handleDeepLink('pending-link');
  assert.equal(harness.state().pendingCount, 1);

  harness.markReady(false);
  harness.setServerReady(true);
  harness.flushPendingDeepLinks({ revealWindowOnFailure: true });
  await harness.processing();

  assert.equal(harness.state().visible, true);
  assert.equal(calls.show, 1);
  assert.equal(calls.focus, 1);
  assert.equal(calls.errors[0][1], 'Could not open proxied Chrome');
});

test('successful startup deep link preserves the intended hidden-window behavior', async () => {
  const { harness, calls } = createHarness({
    parse: () => 'https://example.test/success',
    open: async () => ({ success: true })
  });
  harness.markReady(false);

  harness.handleDeepLink('valid-link', { revealWindowOnFailure: true });
  await harness.processing();

  assert.equal(harness.state().visible, false);
  assert.equal(calls.show, 0);
  assert.equal(calls.focus, 0);
  assert.equal(calls.errors.length, 0);
  assert.deepEqual(calls.opened, ['https://example.test/success']);
});

test('a HAR deep link imports traffic and reveals the HTTP FreeKit window', async () => {
  const target = 'https://example.test/capture.har?download=1';
  const { harness, calls } = createHarness({
    parse: () => target,
    open: async () => ({ success: true })
  });
  harness.markReady(false);

  harness.handleDeepLink('har-link', { revealWindowOnFailure: true });
  await harness.processing();

  assert.equal(harness.state().visible, true);
  assert.equal(calls.show, 1);
  assert.equal(calls.focus, 1);
  assert.deepEqual(calls.imported, [target]);
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.errors, []);
});

test('later deep-link failures retain the existing non-revealing behavior', async () => {
  const { harness, calls } = createHarness({
    parse: () => 'https://example.test/later',
    open: async () => { throw new Error('Later request failed'); }
  });
  harness.markReady(false);

  harness.handleDeepLink('later-link');
  await harness.processing();

  assert.equal(harness.state().visible, false);
  assert.equal(calls.show, 0);
  assert.equal(calls.focus, 0);
  assert.equal(calls.errors.length, 1);
});

test('startup wiring marks direct and queued launch links for failure recovery', () => {
  const startup = section('const startupDeepLink = findDeepLinkArg(process.argv);', '// Set up application menu');
  assert.match(startup, /createWindow\(\{ showOnReady: !launchedFromDeepLink \}\)/);
  assert.match(startup, /handleDeepLink\(startupDeepLink, \{ revealWindowOnFailure: launchedFromDeepLink \}\)/);
  assert.match(startup, /flushPendingDeepLinks\(\{ revealWindowOnFailure: launchedFromDeepLink \}\)/);
});

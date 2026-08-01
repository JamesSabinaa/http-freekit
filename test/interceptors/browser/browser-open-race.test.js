import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_BECAME_INACTIVE_ERROR_CODE,
  BrowserInterceptor
} from '../../../src/interceptors/browser-interceptor.js';
import { normalizeBrowserUrl } from '../../../src/interceptors/browser-url.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

function createManager(interceptor) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map([[interceptor.id, interceptor]]);
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  return manager;
}

test('manager activates one replacement with the normalized URL when a browser closes during Open', async () => {
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  let activeCheck = 0;
  let replacementActive = false;
  const activations = [];
  browser.isActive = async () => {
    activeCheck += 1;
    if (activeCheck === 1) return true;
    return replacementActive;
  };
  browser.isActivable = async () => true;
  browser.activate = async (proxyPort, options) => {
    activations.push({ proxyPort, options });
    replacementActive = true;
    return { success: true, browser: browser.name, url: options.url };
  };
  const manager = createManager(browser);
  const requestedUrl = '  https://example.com/a path?q=hello world  ';
  const normalizedUrl = normalizeBrowserUrl(requestedUrl);

  const result = await manager.openUrl('chrome', 8299, requestedUrl);

  assert.deepEqual(result, { success: true, browser: 'Chrome', url: normalizedUrl });
  assert.deepEqual(activations, [{ proxyPort: 8299, options: { url: normalizedUrl } }]);
  assert.equal(manager.operationsInProgress.size, 0);
});

test('BrowserInterceptor exposes a specific normalized inactive-during-open signal', async () => {
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.isActive = async () => false;
  const requestedUrl = ' https://example.com/a path ';

  await assert.rejects(
    browser.openUrl(requestedUrl),
    error => {
      assert.equal(error.code, BROWSER_BECAME_INACTIVE_ERROR_CODE);
      assert.equal(error.normalizedUrl, normalizeBrowserUrl(requestedUrl));
      return true;
    }
  );
});

test('manager does not activate for invalid URLs or non-race Open errors', async () => {
  let activationCount = 0;
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.isActive = async () => true;
  browser.isActivable = async () => true;
  browser.activate = async () => {
    activationCount += 1;
    return { success: true };
  };
  const manager = createManager(browser);

  await assert.rejects(manager.openUrl('chrome', 8299, '--incognito'), /Invalid URL/);

  const openFailure = new Error('browser opener spawn failed');
  browser.openUrl = async () => { throw openFailure; };
  await assert.rejects(
    manager.openUrl('chrome', 8299, 'https://example.com'),
    error => error === openFailure
  );
  assert.equal(activationCount, 0);
});

test('manager retries only an inactive signal that still reflects inactive state', async () => {
  let activationCount = 0;
  const raceSignal = new Error('stale inactive signal');
  raceSignal.code = BROWSER_BECAME_INACTIVE_ERROR_CODE;
  raceSignal.normalizedUrl = 'https://example.com/';
  const interceptor = {
    id: 'chrome',
    name: 'Chrome',
    isActive: async () => true,
    isActivable: async () => true,
    openUrl: async () => { throw raceSignal; },
    activate: async () => {
      activationCount += 1;
      return { success: true };
    }
  };
  const manager = createManager(interceptor);

  await assert.rejects(
    manager.openUrl('chrome', 8299, 'https://example.com'),
    error => error === raceSignal
  );
  assert.equal(activationCount, 0);
});

test('failed stale-profile cleanup cannot become a replacement activation', async () => {
  let activeCheck = 0;
  let activationCount = 0;
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.active = true;
  browser.profileDir = 'stale-profile';
  browser.isActive = async () => {
    activeCheck += 1;
    return activeCheck === 1;
  };
  browser._cleanup = () => ({ removed: false, reason: 'profile locked' });
  browser.isActivable = async () => true;
  browser.activate = async () => {
    activationCount += 1;
    return { success: true };
  };
  const manager = createManager(browser);

  await assert.rejects(
    manager.openUrl('chrome', 8299, 'https://example.com'),
    error => error.code === 'BROWSER_CLEANUP_PENDING'
  );
  assert.equal(browser.cleanupPending, true);
  assert.equal(activationCount, 0);
});

test('replacement activation failures pass through after exactly one race retry', async () => {
  let activeChecks = 0;
  let activationCount = 0;
  const activationFailure = new Error('replacement spawn failed');
  const normalizedUrl = 'https://example.com/replacement';
  const interceptor = {
    id: 'chrome',
    name: 'Chrome',
    isActive: async () => {
      activeChecks += 1;
      return activeChecks === 1;
    },
    isActivable: async () => true,
    openUrl: async () => {
      const error = new Error('Chrome is not running');
      error.code = BROWSER_BECAME_INACTIVE_ERROR_CODE;
      error.normalizedUrl = normalizedUrl;
      throw error;
    },
    activate: async () => {
      activationCount += 1;
      throw activationFailure;
    }
  };
  const manager = createManager(interceptor);

  await assert.rejects(
    manager.openUrl('chrome', 8299, normalizedUrl),
    error => error === activationFailure
  );
  assert.equal(activationCount, 1);
});

test('an in-flight Open excludes Stop, Activate, and another Open for the same interceptor', async () => {
  let releaseOpen;
  let signalOpenStarted;
  const openGate = new Promise(resolve => { releaseOpen = resolve; });
  const openStarted = new Promise(resolve => { signalOpenStarted = resolve; });
  let openCount = 0;
  let activateCount = 0;
  let deactivateCount = 0;
  const interceptor = {
    id: 'chrome',
    name: 'Chrome',
    isActive: async () => true,
    isActivable: async () => true,
    openUrl: async url => {
      openCount += 1;
      signalOpenStarted();
      await openGate;
      return { success: true, url };
    },
    activate: async () => { activateCount += 1; },
    deactivate: async () => { deactivateCount += 1; }
  };
  const manager = createManager(interceptor);

  const firstOpen = manager.openUrl('chrome', 8299, 'https://example.com/first');
  await openStarted;

  for (const operation of [
    manager.deactivate('chrome'),
    manager.activate('chrome', 8299),
    manager.openUrl('chrome', 8299, 'https://example.com/second')
  ]) {
    await assert.rejects(
      operation,
      error => error.code === 'INTERCEPTOR_OPERATION_IN_PROGRESS'
    );
  }
  assert.equal(openCount, 1);
  assert.equal(activateCount, 0);
  assert.equal(deactivateCount, 0);

  releaseOpen();
  assert.deepEqual(
    await firstOpen,
    { success: true, url: 'https://example.com/first' }
  );
  assert.equal(manager.operationsInProgress.size, 0);
});

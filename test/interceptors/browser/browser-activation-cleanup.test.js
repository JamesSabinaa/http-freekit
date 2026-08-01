import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

test('browser launch preparation failures remove the new managed profile', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  interceptor._findBrowserPath = () => 'test-browser';
  interceptor._createManagedProfile = () => 'test-managed-profile';
  interceptor.ca = {
    systemTrustInstalled: false,
    getSpkiFingerprint: () => {
      throw new Error('CA fingerprint unavailable');
    }
  };
  const cleanupCalls = [];
  interceptor._cleanup = profileDir => {
    cleanupCalls.push(profileDir);
    return { removed: true };
  };

  await assert.rejects(interceptor.activate(8080), /CA fingerprint unavailable/);

  assert.deepEqual(cleanupCalls, ['test-managed-profile']);
  assert.equal(interceptor.profileDir, null);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.proxyPort, null);
  assert.equal(interceptor.active, false);
});

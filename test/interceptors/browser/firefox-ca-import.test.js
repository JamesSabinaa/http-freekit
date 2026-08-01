import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

test('Firefox activation fails when neither NSS nor OS trust can install the CA', async (t) => {
  const interceptor = new BrowserInterceptor('firefox', 'Firefox', 'firefox');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-firefox-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  interceptor._findBrowserPath = () => 'test-firefox';
  interceptor._createManagedProfile = () => profileDir;
  interceptor.ca = {
    systemTrustInstalled: false,
    getCertInfo: () => ({ certificatePath: '/tmp/freekit-ca.pem' })
  };
  interceptor._runCertutil = () => {
    throw new Error('certutil unavailable');
  };
  const cleanupCalls = [];
  interceptor._cleanup = profileDir => {
    cleanupCalls.push(profileDir);
    return { removed: true };
  };

  await assert.rejects(interceptor.activate(8080), /Install Mozilla NSS certutil/);
  assert.deepEqual(cleanupCalls, [profileDir]);
  assert.equal(interceptor.active, false);
});

test('Firefox may fall back only when the FreeKit CA is installed in OS trust', async () => {
  const interceptor = new BrowserInterceptor('firefox', 'Firefox', 'firefox');
  interceptor.profileDir = '/tmp/test-firefox-profile';
  interceptor.ca = {
    systemTrustInstalled: true,
    getCertInfo: () => ({ certificatePath: '/tmp/freekit-ca.pem' })
  };
  interceptor._runCertutil = () => {
    throw new Error('certutil unavailable');
  };

  const originalProfile = interceptor.profileDir;
  assert.equal(await interceptor._importCertToFirefoxProfile(), false);
  assert.equal(interceptor.profileDir, originalProfile);
});

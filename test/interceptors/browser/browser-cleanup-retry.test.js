import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

test('failed isolated-browser shutdown retains state for a later Stop retry', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const launchedProcess = { pid: 4101, exitCode: null, signalCode: null };
  interceptor.active = true;
  interceptor.process = launchedProcess;
  interceptor.profileDir = '/tmp/http-freekit-chrome-retry';
  interceptor.proxyPort = 8080;
  interceptor._isSpawnedProcessRunning = () => false;
  interceptor._refreshTrackedProcessIds = async () => new Set([4102]);
  interceptor._terminateProcessTree = async () => new Set([4102]);
  interceptor._cleanup = () => assert.fail('profile must not be removed while a process survives');

  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);

  assert.equal(interceptor.active, true);
  assert.equal(interceptor.cleanupPending, true);
  assert.equal(interceptor.process, launchedProcess);
  assert.equal(interceptor.profileDir, '/tmp/http-freekit-chrome-retry');
  assert.equal(await interceptor.isActive(), true);

  interceptor._terminateProcessTree = async () => new Set();
  interceptor._cleanup = () => ({ removed: true });
  await interceptor.deactivate();

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.cleanupPending, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.profileDir, null);
});

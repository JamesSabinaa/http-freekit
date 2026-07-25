import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../src/interceptors/electron-interceptor.js';

test('Electron interception passes Chromium proxy switches as process arguments', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.killed = false;

  let spawned;
  const interceptor = new ElectronInterceptor();
  interceptor.ca = { getSpkiFingerprint: () => 'test-spki' };
  interceptor._spawn = (appPath, args, options) => {
    spawned = { appPath, args, options };
    return child;
  };

  const result = await interceptor.activate(8080, { appPath: 'sample-electron-app' });

  assert.equal(result.success, true);
  assert.equal(result.pid, 1234);
  assert.equal(spawned.appPath, 'sample-electron-app');
  assert.deepEqual(spawned.args, [
    '--proxy-server=http://127.0.0.1:8080',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list=test-spki'
  ]);
  assert.equal(spawned.options.env.ELECTRON_EXTRA_LAUNCH_ARGS, undefined);
});

test('manual Electron instructions use real command-line arguments', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = { getSpkiFingerprint: () => 'manual-spki' };

  const result = await interceptor.activate(9090);

  assert.match(result.metadata.instructions, /your-app --proxy-server=http:\/\/127\.0\.0\.1:9090/);
  assert.match(result.metadata.instructions, /--ignore-certificate-errors-spki-list=manual-spki/);
  assert.doesNotMatch(result.metadata.instructions, /ELECTRON_EXTRA_LAUNCH_ARGS/);
});

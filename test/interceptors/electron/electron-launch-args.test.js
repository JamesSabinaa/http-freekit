import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';

test('Electron interception passes Chromium proxy switches as process arguments', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.killed = false;

  let spawned;
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    systemTrustInstalled: false,
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
  interceptor._environment = () => ({
    INHERITED_VALUE: 'preserved',
    NODE_EXTRA_CA_CERTS: 'stale-ca.pem',
    Node_Extra_Ca_Certs: 'stale-mixed-case-ca.pem',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    node_tls_reject_unauthorized: '0'
  });
  interceptor._spawn = (appPath, args, options) => {
    spawned = { appPath, args, options };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  const result = await interceptor.activate(8080, { appPath: 'sample-electron-app' });

  assert.equal(result.success, true);
  assert.equal(result.pid, 1234);
  assert.equal(spawned.appPath, 'sample-electron-app');
  assert.deepEqual(spawned.args, [
    '--proxy-server=http://127.0.0.1:8080',
    '--ignore-certificate-errors-spki-list=test-spki'
  ]);
  assert.equal(spawned.options.env.ELECTRON_EXTRA_LAUNCH_ARGS, undefined);
  assert.equal(spawned.options.env.HTTP_PROXY, 'http://127.0.0.1:8080');
  assert.equal(spawned.options.env.HTTPS_PROXY, 'http://127.0.0.1:8080');
  assert.equal(spawned.options.env.NODE_EXTRA_CA_CERTS, process.execPath);
  assert.equal(spawned.options.env.INHERITED_VALUE, 'preserved');
  assert.equal('NODE_TLS_REJECT_UNAUTHORIZED' in spawned.options.env, false);
  assert.equal('node_tls_reject_unauthorized' in spawned.options.env, false);
  assert.equal('Node_Extra_Ca_Certs' in spawned.options.env, false);
  assert.equal(spawned.options.env.NODE_USE_ENV_PROXY, '1');
});

test('manual Electron instructions use real command-line arguments', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    systemTrustInstalled: false,
    getSpkiFingerprint: () => 'manual-spki'
  };

  const result = await interceptor.activate(9090);

  assert.match(result.metadata.instructions, /your-app --proxy-server=http:\/\/127\.0\.0\.1:9090/);
  assert.match(result.metadata.instructions, /--ignore-certificate-errors-spki-list=manual-spki/);
  assert.doesNotMatch(result.metadata.instructions, /(?:^|\s)--ignore-certificate-errors(?:\s|$)/);
  assert.doesNotMatch(result.metadata.instructions, /ELECTRON_EXTRA_LAUNCH_ARGS/);
});

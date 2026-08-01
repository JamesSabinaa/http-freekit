import assert from 'node:assert/strict';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('JVM deactivation reattaches the agent with a restore action', async () => {
  const interceptor = new JvmInterceptor();
  interceptor.activatedProcesses.set('123', { name: 'Example', mainClass: 'Example' });
  interceptor.active = true;
  const calls = [];
  interceptor._attachAgent = (...args) => {
    calls.push(args);
    return { success: true };
  };

  await interceptor.deactivate({ pid: '123' });

  assert.deepEqual(calls, [['123', null, null, 'deactivate']]);
  assert.equal(interceptor.activatedProcesses.has('123'), false);
  assert.equal(interceptor.active, false);
});

test('failed JVM cleanup remains tracked for retry', async () => {
  const interceptor = new JvmInterceptor();
  interceptor.activatedProcesses.set('123', { name: 'First', mainClass: 'First' });
  interceptor.activatedProcesses.set('456', { name: 'Second', mainClass: 'Second' });
  interceptor.active = true;
  interceptor._attachAgent = pid => pid === '123'
    ? { success: true }
    : { success: false, error: 'target unavailable' };

  await assert.rejects(
    interceptor.deactivate(),
    /PID 456: target unavailable/
  );

  assert.equal(interceptor.activatedProcesses.has('123'), false);
  assert.equal(interceptor.activatedProcesses.has('456'), true);
  assert.equal(interceptor.active, true);
});

test('generated JVM agent restores proxy and TLS defaults', () => {
  const interceptor = new JvmInterceptor();
  const source = interceptor._getAgentSource();

  assert.equal(interceptor._getAgentArgs(null, null, 'deactivate'), 'freekit.action=deactivate');
  assert.match(source, /originalProperties\.put\(property, System\.getProperty\(property\)\)/);
  assert.match(source, /System\.clearProperty\(property\)/);
  assert.match(source, /SSLContext\.setDefault\(originalSslContext\)/);
  assert.match(source, /setDefaultSSLSocketFactory\(originalSslSocketFactory\)/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

test('system-proxy deactivation reports restore failures and remains active', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.previousSettings = { enabled: true, server: 'corporate.proxy:8888' };
  interceptor._restorePreviousSettings = () => {
    throw new Error('registry access denied');
  };

  await assert.rejects(
    interceptor.deactivate(),
    /Failed to restore system proxy settings: registry access denied/
  );
  assert.equal(interceptor.active, true);
  assert.deepEqual(interceptor.previousSettings, {
    enabled: true,
    server: 'corporate.proxy:8888'
  });
});

test('partial registry restore retains the saved settings for retry', () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor.previousSettings = { enabled: true, server: 'corporate.proxy:8888' };
  let calls = 0;
  interceptor._setRegistryValue = () => {
    calls += 1;
    if (calls === 2) throw new Error('ProxyEnable write failed');
  };

  assert.throws(() => interceptor._restorePreviousSettings(), /ProxyEnable write failed/);
  assert.deepEqual(interceptor.previousSettings, {
    enabled: true,
    server: 'corporate.proxy:8888'
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('proxy binds to loopback by default', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(() => proxy.stop());

  assert.equal(proxy.server.address().address, '127.0.0.1');
});

test('remote proxy binding requires an explicit host option', async t => {
  const proxy = new ProxyServer(null, { port: 0, bindHost: '0.0.0.0' });
  await proxy.start();
  t.after(() => proxy.stop());

  assert.equal(proxy.server.address().address, '0.0.0.0');
});

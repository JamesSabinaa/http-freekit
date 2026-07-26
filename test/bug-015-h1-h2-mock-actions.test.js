import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyServer } from '../src/proxy/proxy-server.js';

test('HTTP/1 fallback in H2 all mode delegates every mock action to the full H1 engine', async () => {
  const proxy = new ProxyServer(null);
  const req = { method: 'GET', url: '/resource', headers: {}, rawHeaders: [] };
  const res = {};
  const body = Buffer.from('request');
  const rule = {
    action: { type: 'close' },
    preSteps: [{ type: 'add-request-header', name: 'x-test', value: 'yes' }]
  };
  let captured;
  proxy._serveMockResponse = async (...args) => { captured = args; };

  await proxy._serveMockResponseH1OnH2(
    'request-id', req, res, 'https://example.test/resource',
    'example.test', 443, body, rule, 123, { version: 'TLSv1.3' }
  );

  assert.equal(captured[0], 'request-id');
  assert.equal(captured[1], req);
  assert.equal(captured[2], res);
  assert.equal(captured[3].href, 'https://example.test/resource');
  assert.equal(captured[4], body);
  assert.equal(captured[5], rule);
  assert.equal(captured[6], 123);
  assert.deepEqual(captured[7], {
    protocol: 'https',
    tls: { version: 'TLSv1.3' },
    updatePending: true
  });
});

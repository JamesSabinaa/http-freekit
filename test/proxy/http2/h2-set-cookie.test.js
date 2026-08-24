import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('HTTP/2 response conversion preserves legal repeated fields', () => {
  const proxy = new ProxyServer(null);
  const headers = proxy._toH2ResponseHeaders(200, {
    'set-cookie': [
      'first=one; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'second=two; Path=/'
    ],
    vary: ['accept-encoding', 'origin'],
    'content-type': ['text/plain', 'application/json'],
    connection: 'close'
  });

  assert.equal(headers[':status'], 200);
  assert.deepEqual(headers['set-cookie'], [
    'first=one; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    'second=two; Path=/'
  ]);
  assert.deepEqual(headers.vary, ['accept-encoding', 'origin']);
  assert.equal(headers['content-type'], 'text/plain, application/json');
  assert.equal(headers.connection, undefined);
});

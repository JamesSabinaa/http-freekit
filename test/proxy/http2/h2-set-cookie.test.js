import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('HTTP/2 response conversion preserves repeated Set-Cookie fields', () => {
  const proxy = new ProxyServer(null);
  const headers = proxy._toH2ResponseHeaders(200, {
    'set-cookie': [
      'first=one; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'second=two; Path=/'
    ],
    vary: ['accept-encoding', 'origin'],
    connection: 'close'
  });

  assert.equal(headers[':status'], 200);
  assert.deepEqual(headers['set-cookie'], [
    'first=one; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    'second=two; Path=/'
  ]);
  assert.equal(headers.vary, 'accept-encoding, origin');
  assert.equal(headers.connection, undefined);
});

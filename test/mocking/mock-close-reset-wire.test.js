import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import net from 'node:net';
import test from 'node:test';

import { ProxyServer } from '../../src/proxy/proxy-server.js';

function requestUntilDisconnected(port, pathname) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    let ended = false;
    let errorCode = null;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for ${pathname} disconnect`));
    }, 3000);
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => { ended = true; });
    socket.on('error', error => { errorCode = error.code; });
    socket.on('close', hadError => {
      clearTimeout(timeout);
      resolve({ ended, errorCode, hadError, data: Buffer.concat(chunks) });
    });
    socket.once('connect', () => {
      socket.write(
        `GET http://mock-disconnect.test${pathname} HTTP/1.1\r\n` +
        'Host: mock-disconnect.test\r\n' +
        'Connection: close\r\n\r\n'
      );
    });
  });
}

test('H1 mock Close uses FIN while Reset uses an explicit TCP reset', async t => {
  const captures = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => captures.push(event) });
  proxy.mockRules = [
    {
      enabled: true,
      matchers: [{ type: 'path', matchType: 'exact', value: '/close' }],
      action: { type: 'close' }
    },
    {
      enabled: true,
      matchers: [{ type: 'path', matchType: 'exact', value: '/reset' }],
      action: { type: 'reset' }
    }
  ];
  await proxy.start();
  t.after(() => proxy.stop());

  const close = await requestUntilDisconnected(proxy.server.address().port, '/close');
  const reset = await requestUntilDisconnected(proxy.server.address().port, '/reset');

  assert.equal(close.ended, true);
  assert.equal(close.hadError, false);
  assert.equal(close.errorCode, null);
  assert.equal(close.data.length, 0);
  assert.equal(reset.ended, false);
  assert.equal(reset.hadError, true);
  assert.equal(reset.errorCode, 'ECONNRESET');
  assert.equal(reset.data.length, 0);
  assert.deepEqual(
    captures.filter(event => event.statusCode === 0).map(event => event.statusMessage),
    ['Connection Closed', 'Connection Reset']
  );
});

class FakeH2Stream extends EventEmitter {
  destroyed = false;
  closed = false;
  closeCodes = [];

  close(code) {
    this.closeCodes.push(code);
    this.rstCode = code;
    this.closed = true;
    this.emit('close');
  }
}

test('native H2 Close uses NO_ERROR while Reset uses a nonzero reset code', async () => {
  const captures = [];
  const proxy = new ProxyServer(null, { onRequest: event => captures.push(event) });

  for (const [type, expectedCode, statusMessage] of [
    ['close', http2.constants.NGHTTP2_NO_ERROR, 'Connection Closed'],
    ['reset', http2.constants.NGHTTP2_CANCEL, 'Connection Reset']
  ]) {
    const stream = new FakeH2Stream();
    await proxy._handleH2MockResponse(stream, { action: { type } }, {
      requestId: `h2-${type}`,
      method: 'GET',
      fullUrl: `https://mock-disconnect.test/${type}`,
      authority: 'mock-disconnect.test',
      path: `/${type}`,
      reqHeaders: {},
      body: Buffer.alloc(0),
      requestTrailers: {},
      startTime: Date.now(),
      tlsDetails: null,
      downstream: { complete() {} },
      pendingEmitted: false
    });

    assert.deepEqual(stream.closeCodes, [expectedCode]);
    assert.equal(captures.at(-1).statusMessage, statusMessage);
  }

  assert.notEqual(http2.constants.NGHTTP2_CANCEL, http2.constants.NGHTTP2_NO_ERROR);
  assert.equal(captures.length, 2);
});

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ProxyServer } from '../../src/proxy/proxy-server.js';

function context() {
  return {
    requestId: 'h2-mock',
    method: 'GET',
    fullUrl: 'https://source.test/path',
    authority: 'source.test',
    path: '/path',
    reqHeaders: { host: 'source.test' },
    body: Buffer.alloc(0),
    requestTrailers: {},
    startTime: Date.now(),
    tlsDetails: null,
    downstream: { aborted: false, complete() {} },
    pendingEmitted: false,
    trafficLifecycleId: 'lifecycle'
  };
}

test('native H2 forward mocks capture the sanitized sent headers and trailers', async () => {
  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  proxy._requestMockForward = async () => ({
    statusCode: 201,
    statusMessage: 'Created',
    headers: { 'content-type': 'text/plain', connection: 'close', 'x-origin': 'yes' },
    body: Buffer.from('forwarded'),
    trailers: { 'x-checksum': 'complete' },
    usedUpstreamProxy: false,
    remote: null
  });

  const stream = new PassThrough();
  let sentHeaders;
  let sentTrailers;
  stream.respond = headers => { sentHeaders = headers; };
  stream.sendTrailers = trailers => { sentTrailers = trailers; };
  const originalEnd = stream.end.bind(stream);
  stream.end = body => {
    stream.emit('wantTrailers');
    return originalEnd(body);
  };

  await proxy._handleH2MockResponse(stream, {
    title: 'Forward',
    action: {
      type: 'forward',
      forwardTo: 'https://destination.test',
      addResponseHeaders: { 'X-Added': 'yes', 'Transfer-Encoding': 'chunked' }
    }
  }, context());

  assert.equal(sentHeaders[':status'], 201);
  assert.equal(sentHeaders['x-added'], 'yes');
  assert.equal(sentHeaders.connection, undefined);
  assert.equal(sentHeaders['transfer-encoding'], undefined);
  assert.equal(sentTrailers['x-checksum'], 'complete');
  assert.equal(Object.keys(sentTrailers).length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].responseHeaders['content-type'], 'text/plain');
  assert.equal(events[0].responseHeaders['x-origin'], 'yes');
  assert.equal(events[0].responseHeaders['x-added'], 'yes');
  assert.deepEqual(Object.keys(events[0].responseHeaders).sort(), [
    'content-type', 'x-added', 'x-origin'
  ]);
  assert.equal(events[0].trailers['x-checksum'], 'complete');
});

test('native H2 fixed mock delivery errors are captured as failures', async () => {
  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  const stream = new PassThrough();
  stream.respond = () => { throw new Error('invalid response headers'); };

  await proxy._handleH2MockResponse(stream, {
    title: 'Fixed',
    action: { type: 'fixed-response', status: 200, headers: {}, body: 'ok' }
  }, context());

  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 0);
  assert.equal(events[0].statusMessage, 'Mock Delivery Error');
  assert.match(events[0].error, /invalid response headers/);
});

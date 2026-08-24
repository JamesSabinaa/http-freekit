import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function requestThroughProxy(proxyPort, targetUrl) {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method: 'GET',
      headers: { connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for capture');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function rawHeaderValues(rawHeaders, expectedName) {
  const values = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === expectedName) values.push(rawHeaders[index + 1]);
  }
  return values;
}

test('buffered proxy errors use the same normalized response on wire and in capture',
  async t => {
    const unusedOrigin = http.createServer();
    const unusedPort = await listen(unusedOrigin);
    await close(unusedOrigin);

    const events = [];
    const proxy = new ProxyServer(null, {
      port: 0,
      onRequest: event => events.push(event)
    });
    proxy.mockRules = [{
      enabled: true,
      matchers: [{ type: 'body-contains', value: 'never matches' }],
      action: { type: 'fixed-response', status: 200, body: 'unexpected' }
    }];
    await proxy.start();
    t.after(() => proxy.stop());

    const targetUrl = `http://127.0.0.1:${unusedPort}/synthetic-error`;
    const response = await requestThroughProxy(proxy.server.address().port, targetUrl);
    await waitFor(() => events.some(event => event.statusCode === 502));
    const capture = events.findLast(event => event.statusCode === 502);

    assert.equal(response.statusCode, 502);
    assert.match(response.body, /^Proxy Error: /);
    assert.equal(capture.responseBody, response.body);
    assert.equal(capture.responseBodySize, Buffer.byteLength(response.body));
    assert.equal(capture.responseHeaders['content-type'], 'text/plain');
    assert.equal(
      capture.responseHeaders['content-length'],
      String(Buffer.byteLength(response.body))
    );
    assert.equal(response.headers['content-type'], capture.responseHeaders['content-type']);
    assert.equal(response.headers['content-length'], capture.responseHeaders['content-length']);
  });

test('native H2 synthetic mock errors share normalized wire and capture metadata', async t => {
  const cases = [
    {
      name: 'setup',
      action: { type: 'forward', forwardTo: 'ftp://unsupported.test' },
      statusCode: 500,
      prefix: 'Forward setup error: '
    },
    {
      name: 'delivery',
      action: { type: 'forward', forwardTo: 'https://destination.test' },
      statusCode: 502,
      prefix: 'Forward Error: '
    },
    {
      name: 'missing file path',
      action: { type: 'serve-file' },
      statusCode: 500,
      prefix: 'Mock error: no filePath configured'
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const events = [];
      const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
      proxy._requestMockForward = async () => { throw new Error('upstream unavailable'); };
      const stream = new EventEmitter();
      stream.destroyed = false;
      stream.closed = false;
      stream.respond = headers => { stream.sentHeaders = headers; };
      stream.end = body => { stream.sentBody = Buffer.from(body || ''); };

      await proxy._handleH2MockResponse(stream, { action: scenario.action }, {
        requestId: `h2-forward-${scenario.name}`,
        method: 'GET',
        fullUrl: 'https://source.test/resource',
        authority: 'source.test',
        path: '/resource',
        reqHeaders: { host: 'source.test' },
        body: Buffer.alloc(0),
        requestTrailers: {},
        startTime: Date.now(),
        tlsDetails: null,
        downstream: { aborted: false, complete() {} },
        pendingEmitted: false,
        trafficLifecycleId: `h2-forward-${scenario.name}-lifecycle`
      });

      assert.equal(events.length, 1);
      const capture = events[0];
      const wireBody = stream.sentBody.toString('utf8');
      assert.equal(stream.sentHeaders[':status'], scenario.statusCode);
      assert.match(wireBody, new RegExp(`^${scenario.prefix}`));
      assert.equal(capture.responseBody, wireBody);
      assert.equal(capture.responseBodySize, stream.sentBody.length);
      assert.equal(capture.responseHeaders['content-type'], 'text/plain');
      assert.equal(capture.responseHeaders['content-length'], String(stream.sentBody.length));
      assert.equal(stream.sentHeaders['content-type'], capture.responseHeaders['content-type']);
      assert.equal(stream.sentHeaders['content-length'], capture.responseHeaders['content-length']);
    });
  }
});

test('common H1 missing-file-path errors share normalized wire and capture metadata',
  async () => {
    const events = [];
    const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
    const request = {
      method: 'GET',
      url: '/resource',
      headers: { host: 'source.test' },
      rawHeaders: ['Host', 'source.test'],
      trailers: {}
    };
    const response = new EventEmitter();
    response.destroyed = false;
    response.headersSent = false;
    response.writeHead = (statusCode, headers) => {
      response.statusCode = statusCode;
      response.sentHeaders = headers;
      response.headersSent = true;
    };
    const chunks = [];
    response.write = body => { chunks.push(Buffer.from(body)); };
    response.end = body => {
      if (body) chunks.push(Buffer.from(body));
      response.writableFinished = true;
    };

    await proxy._serveMockResponse(
      'h1-missing-path',
      request,
      response,
      new URL('http://source.test/resource'),
      Buffer.alloc(0),
      { action: { type: 'serve-file' } },
      Date.now(),
      {
        downstream: { aborted: false, complete() {} },
        trafficLifecycleId: 'h1-missing-path-lifecycle'
      }
    );

    assert.equal(events.length, 1);
    const capture = events[0];
    const wireBody = Buffer.concat(chunks).toString('utf8');
    assert.equal(response.statusCode, 500);
    assert.equal(capture.responseBody, wireBody);
    assert.equal(capture.responseBodySize, Buffer.byteLength(wireBody));
    assert.equal(response.sentHeaders['content-type'], capture.responseHeaders['content-type']);
    assert.equal(response.sentHeaders['content-length'], capture.responseHeaders['content-length']);
  });

test('file-open failures retain the normalized body and exact byte count', () => {
  const proxy = new ProxyServer(null);
  const error = Object.assign(new Error('missing file'), { code: 'ENOENT' });

  const failure = proxy._mockFileFailure(
    'missing.txt', 200, 'text/plain', error, 'GET'
  );
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.responseBody, 'File not found: missing.txt');
  assert.equal(failure.responseBodySize, Buffer.byteLength(failure.responseBody));
  assert.equal(failure.responseHeaders['content-type'], 'text/plain');
  assert.equal(
    failure.responseHeaders['content-length'],
    String(failure.responseBodySize)
  );
  assert.equal(failure.wireResponse.body.toString('utf8'), failure.responseBody);

  const headFailure = proxy._mockFileFailure(
    'missing.txt', 200, 'text/plain', error, 'HEAD'
  );
  assert.equal(headFailure.responseBody, '');
  assert.equal(headFailure.responseBodySize, 0);
  assert.equal(headFailure.responseHeaders['content-length'], '0');
  assert.equal(headFailure.wireResponse.body.length, 0);
});

test('raw-tunnel classification stays provisional and finalizes bidirectional bytes once',
  async () => {
    const events = [];
    const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
    const rawSocket = new EventEmitter();
    rawSocket.destroyed = false;
    rawSocket.bytesWritten = 100;
    const tunnel = proxy._trackProvisionalRawTunnel({
      socket: rawSocket,
      hostname: 'raw.test',
      targetPort: 443,
      urlHostname: 'raw.test'
    });

    rawSocket.emit('data', Buffer.alloc(7));
    rawSocket.bytesWritten = 111;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(events.length, 0, 'no completed capture before the tunnel closes');
    rawSocket.emit('close');
    assert.equal(events.length, 1);
    assert.equal(events[0].statusMessage, 'Raw Tunnel');
    assert.equal(events[0].requestBodySize, 7);
    assert.equal(events[0].responseBodySize, 11);
    assert.equal(tunnel.finalize(), false, 'terminalization is idempotent');
    assert.equal(events.length, 1);

    const httpSocket = new EventEmitter();
    httpSocket.destroyed = false;
    httpSocket.bytesWritten = 50;
    const recognized = proxy._trackProvisionalRawTunnel({
      socket: httpSocket,
      hostname: 'http.test',
      targetPort: 443,
      urlHostname: 'http.test'
    });
    httpSocket.emit('data', Buffer.alloc(3));
    httpSocket.bytesWritten = 55;
    assert.equal(recognized.recognizeHttp(), true);
    httpSocket.emit('close');
    assert.equal(events.length, 1, 'recognized HTTP removes the provisional tunnel');
  });

test('buffered upstream response forwarding and capture preserve repeated fields', async t => {
  const origin = http.createServer((_request, response) => {
    response.setHeader('x-repeat', ['first', 'second']);
    response.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    response.setHeader('content-type', 'text/plain');
    response.end('repeated');
  });
  const originPort = await listen(origin);
  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: event => events.push(event)
  });
  proxy.mockRules = [{
    enabled: true,
    matchers: [{ type: 'body-contains', value: 'never matches' }],
    action: { type: 'fixed-response', status: 200, body: 'unexpected' }
  }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const response = await requestThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/repeated`
  );
  await waitFor(() => events.some(event => event.statusCode === 200));
  const capture = events.findLast(event => event.statusCode === 200);

  assert.equal(response.body, 'repeated');
  assert.deepEqual(rawHeaderValues(response.rawHeaders, 'x-repeat'), ['first', 'second']);
  assert.deepEqual(rawHeaderValues(response.rawHeaders, 'set-cookie'), [
    'a=1; Path=/',
    'b=2; Path=/'
  ]);
  assert.deepEqual(capture.responseHeaders['x-repeat'], ['first', 'second']);
  assert.deepEqual(capture.responseHeaders['set-cookie'], [
    'a=1; Path=/',
    'b=2; Path=/'
  ]);
  assert.equal(Object.getPrototypeOf(capture.responseHeaders), null);
});

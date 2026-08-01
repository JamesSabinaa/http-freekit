import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ApiServer } from '../../../src/api/api-server.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function startProxy(upstreamPort) {
  const proxy = new ProxyServer(null, {
    upstreamConnectTimeoutMs: 1000,
    upstreamIdleTimeoutMs: 1000,
    upstreamRetryDelayMs: 0
  });
  proxy.port = 0;
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();
  return proxy;
}

function requestThroughProxy(port, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: 'http://example.test/resource',
      method,
      headers: {
        host: 'example.test',
        connection: 'close',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('retries one transient upstream disconnect for a safe request', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('recovered');
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startProxy(upstreamPort);
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
  });

  const result = await requestThroughProxy(proxy.server.address().port);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'recovered');
  assert.equal(attempts, 2);
});

test('does not replay an unsafe request after an upstream disconnect', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req) => {
    attempts++;
    req.socket.destroy();
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startProxy(upstreamPort);
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
  });

  const result = await requestThroughProxy(proxy.server.address().port, 'POST', 'payload');

  assert.equal(result.statusCode, 502);
  assert.match(result.body, /^Proxy Error:/);
  assert.equal(attempts, 1);
});

test('retries a safe request when an upstream response is aborted', async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts === 1) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      res.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('complete');
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startProxy(upstreamPort);
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
  });

  const result = await requestThroughProxy(proxy.server.address().port);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'complete');
  assert.equal(attempts, 2);
});

test('classifies pre-TLS disconnects as retryable and records their phase', () => {
  const proxy = new ProxyServer(null, { upstreamRetryDelayMs: 0 });
  const err = new Error('Client network socket disconnected before secure TLS connection was established');
  err.code = 'ECONNRESET';

  assert.equal(proxy._isRetryableUpstreamError(err), true);
  assert.equal(proxy._getUpstreamErrorCode(err), 'ECONNRESET');
  assert.equal(proxy._getUpstreamErrorPhase(err), 'tls-handshake');
});

test('captures Chromium background traffic unless Safe Font filtering is enabled', () => {
  const emitted = [];
  const proxy = new ProxyServer(null, { onRequest: event => emitted.push(event) });
  const traffic = {
    source: 'Chrome',
    protocol: 'https'
  };

  const captured = [
    ['accounts.google.com', '/ListAccounts'],
    ['update.googleapis.com', '/service/update2/json'],
    ['www.google.co.uk', '/domainreliability/upload'],
    ['www.gstatic.com', '/og/_/js/k=og.og2.en_US.example'],
    ['www.google.com', '/xjs/_/js/k=xjs.s.en.example'],
    ['www.google.com', '/complete/s'],
    ['www.google.com', '/complete/s?client=chrome'],
    ['www.gstatic.com', '/images/branding/searchlogo/ico/favicon.ico'],
    ['www.gstatic.com', '/images/branding/searchlogo/ico/favicon.ico?cache=1']
  ];

  for (const [host, path] of captured) {
    assert.equal(proxy._shouldSuppressTrafficLog({ ...traffic, host, path }), false, `${host}${path}`);
  }

  assert.equal(proxy._emitPendingRequest({
    ...traffic,
    id: 'chromium-background-request',
    host: 'accounts.google.com',
    path: '/ListAccounts'
  }), true);
  proxy._emitRequestUpdate({
    ...traffic,
    id: 'chromium-background-request',
    host: 'accounts.google.com',
    path: '/ListAccounts'
  });
  assert.deepEqual(emitted.map(event => [event._pending, event._update]), [
    [true, undefined],
    [undefined, true]
  ]);

  proxy.filterSafeFonts = true;
  assert.equal(proxy._shouldSuppressTrafficLog({ ...traffic, host: 'fonts.gstatic.com' }), true);
  assert.equal(proxy._shouldSuppressTrafficLog({ ...traffic, url: 'https://fonts.googleapis.com/css2' }), true);
  assert.equal(proxy._shouldSuppressTrafficLog({ ...traffic, host: 'accounts.google.com' }), false);
  assert.equal(proxy._shouldSuppressTrafficLog({
    ...traffic,
    protocol: 'ws-frame',
    host: 'fonts.gstatic.com'
  }), false);
});

test('reuses an upstream keep-alive agent until the proxy changes', () => {
  const proxy = new ProxyServer(null);
  proxy.setUpstreamProxy({ host: 'proxy-one.test', port: 8080, type: 'http' });
  const first = proxy._getUpstreamAgent();

  assert.equal(proxy._getUpstreamAgent(), first);
  assert.equal(first.keepAlive, true);

  const firstGeneration = proxy.getUpstreamProxyGeneration();
  proxy.setUpstreamProxy({ host: 'proxy-two.test', port: 8080, type: 'http' });
  const second = proxy._getUpstreamAgent();

  assert.notEqual(second, first);
  assert.equal(proxy.getUpstreamProxyGeneration(), firstGeneration + 1);
  proxy._destroyUpstreamAgent();
});

test('a matching passthrough rule prevents lower mock rules from winning', () => {
  const proxy = new ProxyServer(null);
  const fallbackRule = {
    enabled: true,
    matchers: [{ type: 'wildcard' }],
    action: { type: 'fixed-response', status: 200 }
  };
  proxy.mockRules = [
    {
      enabled: true,
      matchers: [{ type: 'path', matchType: 'exact', value: '/allowed' }],
      action: { type: 'passthrough' }
    },
    fallbackRule
  ];

  assert.equal(proxy._findMockRule('GET', 'http://example.test/allowed', {}, ''), undefined);
  assert.equal(proxy._findMockRule('GET', 'http://example.test/blocked', {}, ''), fallbackRule);
});

test('coalesces concurrent rotations and ignores failures from an old proxy generation', async () => {
  let generation = 4;
  let rotations = 0;
  const fakeProxy = {
    upstreamProxy: { host: 'proxy.test', port: 8080, type: 'http' },
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    getUpstreamProxyGeneration: () => generation,
    matchApiSpec: () => null
  };
  const api = new ApiServer(fakeProxy, null, null);
  api.settings = {
    get: (key) => key === 'autoRotateProxyOnError'
      ? { enabled: true, provider: 'test-provider' }
      : undefined,
    set: () => {}
  };
  api._rotateBottingToolsProxy = async () => {
    rotations++;
    await waitForImmediate();
    generation++;
    return { provider: 'test-provider', upstreamProxy: fakeProxy.upstreamProxy };
  };

  const [first, second] = await Promise.all([
    api._rotateProxyForTransparentRetry({ proxyGeneration: 4 }),
    api._rotateProxyForTransparentRetry({ proxyGeneration: 4 })
  ]);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(rotations, 1);

  const stale = await api._rotateProxyForTransparentRetry({ proxyGeneration: 4 });
  assert.equal(stale, true);
  assert.equal(rotations, 1);

  const cooledDown = await api._rotateProxyForTransparentRetry({ proxyGeneration: generation });
  assert.equal(cooledDown, false);
  assert.equal(rotations, 1);

  assert.equal(api._getAutoRotateProxyReason({
    errorCode: 'ECONNRESET',
    error: 'Client network socket disconnected before secure TLS connection was established'
  }), 'proxy connection failure');
});

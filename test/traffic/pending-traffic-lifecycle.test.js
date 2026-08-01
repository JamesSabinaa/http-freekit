import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { ApiServer } from '../../src/api/api-server.js';
import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function openTunnel(proxyPort, authority) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);

  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length > 0) socket.unshift(remaining);
  return socket;
}

async function connectTls(proxyPort, authority, protocols) {
  const socket = await openTunnel(proxyPort, authority);
  const hostname = new URL(`https://${authority}`).hostname;
  const secureSocket = tls.connect({
    socket,
    servername: net.isIP(hostname) ? undefined : hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

async function requestH1(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const chunks = [];
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  socket.write(
    `GET /resource HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n` +
    'Authorization: Bearer remove-me\r\nX-Remove-Me: yes\r\n\r\n'
  );
  await once(socket, 'end');
  const response = Buffer.concat(chunks).toString('utf8');
  const statusMatch = response.match(/^HTTP\/1\.1 (\d+)/);
  assert.ok(statusMatch, response);
  return {
    statusCode: Number(statusMatch[1]),
    body: response.slice(response.indexOf('\r\n\r\n') + 4)
  };
}

async function requestH1AllowDisconnect(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const chunks = [];
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  socket.write(`GET /resource HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
  await new Promise(resolve => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    socket.once('end', settle);
    socket.once('close', settle);
    socket.once('error', settle);
  });
  const response = Buffer.concat(chunks).toString('utf8');
  const statusMatch = response.match(/^HTTP\/1\.1 (\d+)/);
  return statusMatch ? Number(statusMatch[1]) : null;
}

async function requestH2(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  await once(client, 'connect');
  const request = client.request({
    ':method': 'GET',
    ':path': '/resource',
    ':authority': authority,
    ':scheme': 'https',
    authorization: 'Bearer remove-me',
    'x-remove-me': 'yes'
  });
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  const responsePromise = once(request, 'response');
  const endPromise = once(request, 'end');
  request.end();
  const [headers] = await responsePromise;
  await endPromise;
  client.close();
  await once(client, 'close');
  return { statusCode: headers[':status'], body: Buffer.concat(chunks).toString('utf8') };
}

function attachTrafficLifecycle(proxy) {
  const api = new ApiServer(proxy, null, null);
  const events = [];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  proxy.onRequest = event => {
    events.push(structuredClone(event));
    api.onTrafficEvent(event);
  };
  return {
    api,
    events,
    broadcasts,
    reset() {
      api.trafficLog = [];
      api._pendingTrafficIds.clear();
      api._clearedPendingTrafficIds.clear();
      events.length = 0;
      broadcasts.length = 0;
    }
  };
}

function assertSingleLifecycle(capture, expectedStatus, label, expectedUpdates = null) {
  assert.equal(capture.api.trafficLog.length, 1, `${label}: one final traffic row`);
  assert.equal(capture.api.trafficLog[0].statusCode, expectedStatus, `${label}: final status`);
  assert.equal(capture.events[0]?._pending, true, `${label}: starts pending`);
  assert.ok(capture.events.length >= 2, `${label}: has a completion`);
  assert.equal(capture.events.slice(1).every(event => event._update === true), true,
    `${label}: every post-pending event is an update`);
  assert.equal(new Set(capture.events.map(event => event.id)).size, 1, `${label}: stable ID`);
  assert.equal(capture.broadcasts[0]?.type, 'request', `${label}: pending request event`);
  assert.equal(capture.broadcasts.slice(1).every(event => event.type === 'request-update'), true,
    `${label}: completion update events`);
  if (expectedUpdates !== null) {
    assert.equal(capture.broadcasts.length - 1, expectedUpdates, `${label}: update count`);
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for traffic completion');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function createInterceptingProxy(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-pending-lifecycle-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setTlsFingerprint('passthrough');
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { proxy, ca, dataDir };
}

test('fixed mocks replace pending traffic across intercepted H1, native H2, and H1-on-H2',
  { timeout: 20000 }, async t => {
    const { proxy } = await createInterceptingProxy(t);
    const capture = attachTrafficLifecycle(proxy);
    const authority = 'pending-lifecycle.test:443';
    const scenarios = [
      { name: 'intercepted HTTPS H1', mode: 'disabled', send: requestH1 },
      { name: 'native H2', mode: 'h2-only', send: requestH2 },
      { name: 'H1-on-H2', mode: 'all', send: requestH1 }
    ];

    for (const scenario of scenarios) {
      capture.reset();
      proxy.setHttp2Config(scenario.mode);
      proxy.mockRules = [{
        enabled: true,
        matchers: [],
        action: {
          type: 'fixed-response',
          status: 209,
          headers: { 'content-type': 'text/plain', 'content-length': '5' },
          body: 'fixed'
        }
      }];

      const response = await scenario.send(proxy.server.address().port, authority);
      assert.equal(response.statusCode, 209, scenario.name);
      assert.equal(response.body, 'fixed', scenario.name);
      assertSingleLifecycle(capture, 209, scenario.name, 1);
    }
  });

test('intercepted HTTPS H1 terminal mock outcomes all replace the pending row',
  { timeout: 20000 }, async t => {
    const { proxy, dataDir } = await createInterceptingProxy(t);
    const capture = attachTrafficLifecycle(proxy);
    const authority = 'pending-h1-actions.test:443';
    const filePath = path.join(dataDir, 'mock-file.txt');
    await writeFile(filePath, 'file');
    const forwardOrigin = http.createServer((_request, response) => {
      response.writeHead(207, { 'content-type': 'text/plain', 'content-length': '9' });
      response.end('forwarded');
    });
    const forwardPort = await listen(forwardOrigin);
    t.after(() => close(forwardOrigin));
    proxy.setHttp2Config('disabled');

    const scenarios = [
      { name: 'fixed', action: { type: 'fixed-response', status: 201, body: 'ok' }, status: 201 },
      {
        name: 'forward success',
        action: { type: 'forward', forwardTo: `http://127.0.0.1:${forwardPort}` },
        status: 207
      },
      { name: 'forward setup failure', action: { type: 'forward', forwardTo: 'ftp://bad.test' }, status: 500 },
      {
        name: 'file success',
        action: { type: 'serve-file', filePath, contentType: 'text/plain', status: 206 },
        status: 206
      },
      {
        name: 'file failure',
        action: { type: 'serve-file', filePath: path.join(dataDir, 'missing.txt') },
        status: 500
      },
      { name: 'close', action: { type: 'close' }, status: 0, disconnect: true },
      { name: 'reset', action: { type: 'reset' }, status: 0, disconnect: true }
    ];

    for (const scenario of scenarios) {
      capture.reset();
      proxy.mockRules = [{ enabled: true, matchers: [], action: scenario.action }];
      const wireStatus = scenario.disconnect
        ? await requestH1AllowDisconnect(proxy.server.address().port, authority)
        : (await requestH1(proxy.server.address().port, authority)).statusCode;
      if (!scenario.disconnect) assert.equal(wireStatus, scenario.status, scenario.name);
      await waitFor(() => capture.events.some(event => event._update));
      assertSingleLifecycle(capture, scenario.status, `intercepted HTTPS H1 ${scenario.name}`, 1);
    }
  });

test('request and response breakpoints remain one lifecycle across all intercepted protocols',
  { timeout: 30000 }, async t => {
    const { proxy, ca } = await createInterceptingProxy(t);
    const originCertificate = await ca.generateCertForHost('localhost');
    const observedHeaders = [];
    const observedPaths = [];
    const origin = https.createServer({
      key: originCertificate.key,
      cert: originCertificate.cert
    }, (request, response) => {
      observedHeaders.push(request.headers);
      observedPaths.push(request.url);
      response.writeHead(203, {
        'content-type': 'text/plain',
        'content-length': '6'
      });
      response.end('origin');
    });
    const originPort = await listen(origin);
    t.after(() => close(origin));
    proxy.setHttpsWhitelist(['localhost']);
    const capture = attachTrafficLifecycle(proxy);
    const authority = `localhost:${originPort}`;
    const protocols = [
      { name: 'intercepted HTTPS H1', mode: 'disabled', send: requestH1 },
      { name: 'native H2', mode: 'h2-only', send: requestH2 },
      { name: 'H1-on-H2', mode: 'all', send: requestH1 }
    ];

    for (const phase of ['request', 'response']) {
      for (const protocol of protocols) {
        capture.reset();
        proxy.setHttp2Config(protocol.mode);
        proxy.mockRules = [{
          enabled: true,
          matchers: [],
          action: { type: `breakpoint-${phase}` }
        }];
        proxy.onBreakpoint = event => {
          if (event.type !== 'breakpoint-hit') return;
          const modifications = phase === 'response'
            ? {
                status: 202,
                headers: { 'content-type': 'text/plain', 'content-length': '6' },
                body: 'edited'
              }
            : { headers: { connection: 'close', 'x-kept': 'yes' } };
          setImmediate(() => proxy.resumeBreakpoint(event.requestId, modifications));
        };

        const response = await protocol.send(proxy.server.address().port, authority);
        const expectedStatus = phase === 'response' ? 202 : 203;
        assert.equal(response.statusCode, expectedStatus, `${protocol.name} ${phase}`);
        assert.equal(response.body, phase === 'response' ? 'edited' : 'origin',
          `${protocol.name} ${phase}`);
        const originHeaders = observedHeaders.at(-1);
        const activePauses = capture.events.filter(
          event => event.source === 'breakpoint' && event.statusCode === 0
        );
        assert.ok(activePauses.length > 0, `${protocol.name} emits an active pause`);
        assert.equal(
          activePauses.every(event => event.breakpointActive === true),
          true,
          `${protocol.name} marks active pause traffic`
        );
        if (phase === 'request') {
          assert.equal(originHeaders.authorization, undefined, `${protocol.name} removes authorization`);
          assert.equal(originHeaders['x-remove-me'], undefined, `${protocol.name} removes edited header`);
          assert.equal(originHeaders['x-kept'], 'yes', `${protocol.name} keeps replacement header`);
        } else {
          const responsePauses = capture.events.filter(
            event => event.statusMessage === 'Breakpoint (response)'
          );
          assert.ok(responsePauses.length > 0, `${protocol.name} emits a response pause`);
          assert.equal(
            responsePauses.every(event => event.breakpointPhase === 'response'),
            true,
            `${protocol.name} marks every response pause for response editing`
          );
        }
        assertSingleLifecycle(capture, expectedStatus, `${protocol.name} ${phase}`, 3);
      }
    }

    for (const protocol of protocols) {
      capture.reset();
      proxy.setHttp2Config(protocol.mode);
      proxy.mockRules = [{
        enabled: true,
        matchers: [],
        action: { type: 'breakpoint-request-response' }
      }];
      proxy.onBreakpoint = event => {
        if (event.type !== 'breakpoint-hit') return;
        const modifications = event.phase === 'response'
          ? {
              status: 202,
              headers: { 'content-type': 'text/plain', 'content-length': '6' },
              body: 'edited'
            }
          : {
              url: `https://${authority}/combined`,
              headers: {
                connection: 'close',
                host: 'stale.example.test',
                'x-combined': 'yes'
              }
            };
        setImmediate(() => proxy.resumeBreakpoint(event.requestId, modifications));
      };

      const response = await protocol.send(proxy.server.address().port, authority);
      assert.equal(response.statusCode, 202, `${protocol.name} combined status`);
      assert.equal(response.body, 'edited', `${protocol.name} combined body`);
      const originHeaders = observedHeaders.at(-1);
      assert.equal(originHeaders.authorization, undefined,
        `${protocol.name} combined removes authorization`);
      assert.equal(originHeaders['x-remove-me'], undefined,
        `${protocol.name} combined removes edited header`);
      assert.equal(originHeaders['x-combined'], 'yes',
        `${protocol.name} combined forwards request edits`);
      assert.equal(originHeaders.host, authority,
        `${protocol.name} combined synchronizes origin Host`);
      assert.equal(observedPaths.at(-1), '/combined',
        `${protocol.name} combined forwards URL edits`);
      const responseBreakpoint = capture.events.find(event => event.breakpointPhase === 'response');
      assert.equal(responseBreakpoint?.requestHeaders?.host, authority,
        `${protocol.name} response breakpoint captures synchronized Host`);
      assert.equal(capture.events.at(-1)?.requestHeaders?.host, authority,
        `${protocol.name} final capture keeps synchronized Host`);
      const responsePauses = capture.events.filter(
        event => event.statusMessage === 'Breakpoint (response)'
      );
      assert.ok(responsePauses.length > 0, `${protocol.name} combined emits a response pause`);
      assert.equal(
        responsePauses.every(event => event.breakpointPhase === 'response'),
        true,
        `${protocol.name} combined marks every response pause for response editing`
      );
      assertSingleLifecycle(capture, 202, `${protocol.name} combined`, 5);
    }
  });

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.closed = false;
    this.headersSent = false;
    this.socket = { destroy: () => { this.destroyed = true; } };
  }

  respond(headers) {
    this.headersSent = true;
    this.headers = headers;
  }

  writeHead(statusCode, headers = {}) {
    this.headersSent = true;
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(body) {
    this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  }

  addTrailers(trailers) {
    this.trailers = trailers;
  }

  end(body = '') {
    if (body !== '') this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

function seedPending(proxy, requestId, protocol, timestamp = Date.now()) {
  proxy._emitPendingRequest({
    id: requestId,
    protocol,
    method: 'GET',
    url: 'https://actions.test/resource',
    host: 'actions.test',
    path: '/resource',
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp,
    source: 'proxy',
    tls: null,
    remote: null
  });
}

function configureActionDependency(proxy, dependency) {
  if (dependency === 'forward-success') {
    proxy._requestMockForward = async () => ({
      statusCode: 207,
      statusMessage: 'Multi-Status',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('forwarded'),
      trailers: {},
      remote: { address: '127.0.0.1', port: 443 }
    });
  } else if (dependency === 'forward-error') {
    proxy._requestMockForward = async () => { throw new Error('forward failed'); };
  } else if (dependency === 'file-success') {
    proxy._streamMockFile = async (_filePath, _destination, start) => {
      start();
      return { content: Buffer.from('file'), size: 4, truncated: false };
    };
  } else if (dependency === 'file-error') {
    proxy._streamMockFile = async () => { throw new Error('file failed'); };
  }
}

const mockActionCases = [
  { name: 'fixed', action: { type: 'fixed-response', status: 201, body: 'ok' }, status: 201 },
  { name: 'close', action: { type: 'close' }, status: 0 },
  { name: 'reset', action: { type: 'reset' }, status: 0 },
  {
    name: 'forward success',
    action: { type: 'forward', forwardTo: 'https://forward.test' },
    dependency: 'forward-success',
    status: 207
  },
  {
    name: 'forward failure',
    action: { type: 'forward', forwardTo: 'https://forward.test' },
    dependency: 'forward-error',
    status: 502
  },
  { name: 'forward setup failure', action: { type: 'forward', forwardTo: 'ftp://bad.test' }, status: 500 },
  {
    name: 'file success',
    action: { type: 'serve-file', filePath: 'present.txt', status: 206 },
    dependency: 'file-success',
    status: 206
  },
  {
    name: 'file failure',
    action: { type: 'serve-file', filePath: 'missing.txt' },
    dependency: 'file-error',
    status: 500
  },
  { name: 'missing file path', action: { type: 'serve-file' }, status: 500 }
];

test('native H2 mock terminal actions all complete their pending row', async t => {
  for (const scenario of mockActionCases) {
    await t.test(scenario.name, async () => {
      const proxy = new ProxyServer(null);
      const capture = attachTrafficLifecycle(proxy);
      const requestId = `h2-${scenario.name}`;
      const stream = new FakeResponse();
      const startTime = Date.now();
      configureActionDependency(proxy, scenario.dependency);
      seedPending(proxy, requestId, 'h2', startTime);

      await proxy._handleH2MockResponse(stream, { action: scenario.action }, {
        requestId,
        method: 'GET',
        fullUrl: 'https://actions.test/resource',
        authority: 'actions.test',
        path: '/resource',
        reqHeaders: {},
        body: Buffer.alloc(0),
        requestTrailers: {},
        startTime,
        tlsDetails: null,
        downstream: null
      });

      assertSingleLifecycle(capture, scenario.status, `native H2 ${scenario.name}`, 1);
    });
  }
});

test('H1-on-H2 mock terminal actions all complete through the shared H1 engine', async t => {
  for (const scenario of mockActionCases) {
    await t.test(scenario.name, async () => {
      const proxy = new ProxyServer(null);
      const capture = attachTrafficLifecycle(proxy);
      const requestId = `h1-on-h2-${scenario.name}`;
      const response = new FakeResponse();
      const request = {
        method: 'GET',
        url: '/resource',
        headers: {},
        rawHeaders: [],
        trailers: {}
      };
      const startTime = Date.now();
      configureActionDependency(proxy, scenario.dependency);
      seedPending(proxy, requestId, 'https', startTime);

      await proxy._serveMockResponseH1OnH2(
        requestId,
        request,
        response,
        'https://actions.test/resource',
        'actions.test',
        443,
        Buffer.alloc(0),
        { action: scenario.action },
        startTime,
        null
      );

      assertSingleLifecycle(capture, scenario.status, `H1-on-H2 ${scenario.name}`, 1);
    });
  }
});

test('ordinary non-pending H1 mocks remain append-only', async () => {
  const proxy = new ProxyServer(null);
  const capture = attachTrafficLifecycle(proxy);
  const response = new FakeResponse();
  await proxy._serveMockResponse(
    'ordinary-h1',
    { method: 'GET', headers: {}, rawHeaders: [], trailers: {} },
    response,
    new URL('http://ordinary.test/resource'),
    Buffer.alloc(0),
    { action: { type: 'fixed-response', status: 204, body: '' } },
    Date.now()
  );

  assert.equal(capture.api.trafficLog.length, 1);
  assert.deepEqual(capture.broadcasts.map(event => event.type), ['request']);
  assert.equal(capture.events[0]._pending, undefined);
  assert.equal(capture.events[0]._update, undefined);
  assert.equal(capture.api.trafficLog[0].statusCode, 204);
});

test('a mock remains suppressed when traffic filtering hid its pending event', async () => {
  const proxy = new ProxyServer(null);
  const capture = attachTrafficLifecycle(proxy);
  proxy._shouldSuppressTrafficLog = data => data._pending === true;
  const startTime = Date.now();
  const pendingEmitted = proxy._emitPendingRequest({
    id: 'filtered-pending',
    protocol: 'https',
    method: 'GET',
    url: 'https://filtered.test/resource',
    host: 'filtered.test',
    path: '/resource',
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp: startTime,
    source: 'proxy'
  });
  assert.equal(pendingEmitted, false);

  await proxy._serveMockResponseH1OnH2(
    'filtered-pending',
    { method: 'GET', url: '/resource', headers: {}, rawHeaders: [], trailers: {} },
    new FakeResponse(),
    'https://filtered.test/resource',
    'filtered.test',
    443,
    Buffer.alloc(0),
    { action: { type: 'fixed-response', status: 205, body: '' } },
    startTime,
    null,
    null,
    pendingEmitted
  );

  assert.equal(capture.api.trafficLog.length, 0);
  assert.deepEqual(capture.broadcasts, []);
  assert.deepEqual(capture.events, []);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
});

test('Safe Font filtering remains stable across each pending request lifecycle', () => {
  for (const initiallyFiltered of [false, true]) {
    const proxy = new ProxyServer(null);
    const capture = attachTrafficLifecycle(proxy);
    proxy.filterSafeFonts = initiallyFiltered;
    const baseEvent = {
      id: `font-${initiallyFiltered}`,
      protocol: 'https',
      method: 'GET',
      url: 'https://fonts.gstatic.com/font.woff2',
      host: 'fonts.gstatic.com',
      path: '/font.woff2',
      requestHeaders: {},
      requestBody: '',
      requestBodySize: 0,
      timestamp: Date.now(),
      source: 'Chrome'
    };

    assert.equal(proxy._emitPendingRequest({ ...baseEvent }), !initiallyFiltered);
    proxy.filterSafeFonts = !initiallyFiltered;
    proxy._emitRequestUpdate({
      ...baseEvent,
      _trafficLifecycleComplete: false,
      statusCode: 0,
      statusMessage: 'Breakpoint (response)',
      responseHeaders: {},
      responseBody: '',
      responseBodySize: 0,
      duration: 5
    });
    assert.equal(proxy._pendingTrafficLogDecisions.size, 1);
    proxy._emitRequestUpdate({
      ...baseEvent,
      statusCode: 200,
      responseHeaders: {},
      responseBody: '',
      responseBodySize: 0,
      duration: 10
    });

    if (initiallyFiltered) {
      assert.equal(capture.api.trafficLog.length, 0);
      assert.deepEqual(capture.broadcasts, []);
    } else {
      assert.equal(capture.api.trafficLog.length, 1);
      assert.equal(capture.api.trafficLog[0].statusCode, 200);
      assert.deepEqual(capture.broadcasts.map(event => event.type), [
        'request',
        'request-update',
        'request-update'
      ]);
      assert.equal(capture.events.every(event => event._trafficLifecycleComplete === undefined), true);
    }
    assert.equal(capture.api._pendingTrafficIds.size, 0);
    assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
  }
});

test('a hidden pending lifecycle stays hidden through append-style intermediate events', () => {
  const proxy = new ProxyServer(null);
  const capture = attachTrafficLifecycle(proxy);
  proxy.filterSafeFonts = true;
  const baseEvent = {
    id: 'font-append-fallback',
    protocol: 'https',
    method: 'GET',
    url: 'https://fonts.gstatic.com/font.woff2',
    host: 'fonts.gstatic.com',
    path: '/font.woff2',
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp: Date.now(),
    source: 'Chrome'
  };

  assert.equal(proxy._emitPendingRequest({ ...baseEvent }), false);
  proxy.filterSafeFonts = false;
  assert.equal(proxy._emitRequest({
    ...baseEvent,
    _trafficLifecycleComplete: false,
    statusCode: 0,
    statusMessage: 'Breakpoint',
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    duration: 5
  }), false);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 1);
  assert.equal(proxy._emitRequest({
    ...baseEvent,
    statusCode: 200,
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    duration: 10
  }), false);

  assert.deepEqual(capture.events, []);
  assert.deepEqual(capture.broadcasts, []);
  assert.equal(capture.api.trafficLog.length, 0);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
});

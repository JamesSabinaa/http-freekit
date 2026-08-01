import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

const PROXY_AUTH = 'Basic ' + Buffer.from('mock-user:mock-pass').toString('base64');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
}

async function close(server, destroySockets) {
  destroySockets?.();
  await new Promise(resolve => server.close(resolve));
}

function requestH1(options, body = null) {
  return new Promise((resolve, reject) => {
    const request = http.request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function openTunnel(proxyPort, hostname) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${hostname}:443 HTTP/1.1\r\n` +
    `Host: ${hostname}:443\r\n\r\n`
  );

  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length) socket.unshift(remaining);
  return socket;
}

async function connectTls(proxyPort, hostname, protocols) {
  const tunnel = await openTunnel(proxyPort, hostname);
  const socket = tls.connect({
    socket: tunnel,
    servername: hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(socket, 'secureConnect');
  return socket;
}

function parseRawH1Response(raw) {
  const split = raw.indexOf('\r\n\r\n');
  assert.notEqual(split, -1, raw);
  const head = raw.slice(0, split);
  const headers = {};
  for (const line of head.split('\r\n').slice(1)) {
    const separator = line.indexOf(':');
    if (separator !== -1) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return {
    statusCode: Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1]),
    headers,
    body: raw.slice(split + 4)
  };
}

async function requestInterceptedH1(proxyPort, hostname, requestPath) {
  const socket = await connectTls(proxyPort, hostname, ['http/1.1']);
  assert.equal(socket.alpnProtocol, 'http/1.1');
  const response = new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.once('error', reject);
    socket.once('end', () => resolve(parseRawH1Response(Buffer.concat(chunks).toString('latin1'))));
  });
  socket.write(
    `GET ${requestPath} HTTP/1.1\r\n` +
    `Host: ${hostname}\r\n` +
    'Proxy-Authorization: Basic client-secret\r\n' +
    'X-Forwarded-For: 203.0.113.8\r\n' +
    'Connection: close\r\n\r\n'
  );
  return response;
}

async function requestInterceptedH2(proxyPort, hostname, requestPath) {
  const socket = await connectTls(proxyPort, hostname, ['h2']);
  assert.equal(socket.alpnProtocol, 'h2');
  const session = http2.connect(`https://${hostname}`, { createConnection: () => socket });
  await once(session, 'connect');
  try {
    const request = session.request({
      ':method': 'GET',
      ':path': requestPath,
      ':scheme': 'https',
      ':authority': hostname,
      'x-forwarded-for': '203.0.113.9'
    });
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    const responsePromise = once(request, 'response');
    const endPromise = once(request, 'end');
    request.end();
    const [headers] = await responsePromise;
    await endPromise;
    return {
      statusCode: headers[':status'],
      headers,
      body: Buffer.concat(chunks).toString('utf8')
    };
  } finally {
    session.close();
    await once(session, 'close');
  }
}

function createCountingUpstream() {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: { ...request.headers } });
    let target;
    try {
      target = new URL(request.url);
    } catch (error) {
      response.writeHead(400);
      response.end(error.message);
      return;
    }

    const headers = { ...request.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const destinationRequest = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: request.method,
      headers
    }, destinationResponse => {
      response.writeHead(destinationResponse.statusCode, destinationResponse.headers);
      destinationResponse.pipe(response);
    });
    destinationRequest.once('error', error => {
      response.writeHead(502);
      response.end(error.message);
    });
    request.pipe(destinationRequest);
  });
  return { requests, server };
}

function assertForwardedResponse(response, requestPath) {
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['x-mock-response'], 'added');
  assert.equal(response.body, `destination:${requestPath}`);
}

test('mock forwards use the configured upstream across H1, intercepted HTTPS, and H2', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-mock-forward-proxy-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();

  const destinationRequests = [];
  const destination = http.createServer((request, response) => {
    destinationRequests.push({ url: request.url, headers: { ...request.headers } });
    const body = `destination:${request.url}`;
    response.writeHead(201, {
      'content-type': 'text/plain',
      'content-length': String(Buffer.byteLength(body)),
      'x-destination': 'yes'
    });
    response.end(body);
  });
  const destroyDestinationSockets = trackSockets(destination);
  const destinationPort = await listen(destination);

  const upstream = createCountingUpstream();
  const destroyUpstreamSockets = trackSockets(upstream.server);
  const upstreamPort = await listen(upstream.server);

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: {
      type: 'forward',
      forwardTo: `http://127.0.0.1:${destinationPort}`,
      addRequestHeaders: { 'X-Mock-Request': 'added' },
      addResponseHeaders: { 'X-Mock-Response': 'added' }
    }
  }];
  proxy.setUpstreamProxy({
    host: '127.0.0.1',
    port: upstreamPort,
    type: 'http',
    auth: 'mock-user:mock-pass'
  });
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(upstream.server, destroyUpstreamSockets);
    await close(destination, destroyDestinationSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const proxyPort = proxy.server.address().port;
  const plainResponse = await requestH1({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: 'http://source.example/plain',
    headers: {
      host: 'source.example',
      'proxy-authorization': 'Basic client-secret',
      'x-forwarded-for': '203.0.113.7'
    }
  });
  assertForwardedResponse(plainResponse, '/plain');

  proxy.setHttp2Config('disabled');
  assertForwardedResponse(
    await requestInterceptedH1(proxyPort, 'secure-h1.example', '/secure-h1'),
    '/secure-h1'
  );

  proxy.setHttp2Config('h2-only');
  assertForwardedResponse(
    await requestInterceptedH2(proxyPort, 'secure-h2.example', '/secure-h2'),
    '/secure-h2'
  );

  proxy.setHttp2Config('all');
  assertForwardedResponse(
    await requestInterceptedH1(proxyPort, 'fallback-h1.example', '/fallback-h1'),
    '/fallback-h1'
  );

  assert.equal(upstream.requests.length, 4);
  assert.deepEqual(
    upstream.requests.map(request => new URL(request.url).pathname),
    ['/plain', '/secure-h1', '/secure-h2', '/fallback-h1']
  );
  for (const request of upstream.requests) {
    assert.equal(request.headers['proxy-authorization'], PROXY_AUTH);
    assert.equal(request.headers['x-forwarded-for'], undefined);
    assert.equal(request.headers['x-mock-request'], 'added');
  }
  assert.equal(destinationRequests.length, 4);
  for (const request of destinationRequests) {
    assert.equal(request.headers['proxy-authorization'], undefined);
    assert.equal(request.headers['x-forwarded-for'], undefined);
    assert.equal(request.headers['x-mock-request'], 'added');
    assert.equal(request.headers.host, `127.0.0.1:${destinationPort}`);
  }
  assert.deepEqual(
    events.filter(event => event.source === 'mock').map(event => event.protocol),
    ['http', 'https', 'h2', 'https']
  );

  proxy.setUpstreamProxy({
    host: '127.0.0.1',
    port: upstreamPort,
    type: 'http',
    auth: 'mock-user:mock-pass',
    noProxy: [`127.0.0.1:${destinationPort}`]
  });
  assertForwardedResponse(await requestH1({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: 'http://source.example/no-proxy',
    headers: { host: 'source.example' }
  }), '/no-proxy');
  assert.equal(upstream.requests.length, 4);
  assert.equal(destinationRequests.length, 5);

  proxy.setUpstreamProxy(null);
  assertForwardedResponse(await requestH1({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: 'http://source.example/direct',
    headers: { host: 'source.example' }
  }), '/direct');
  assert.equal(upstream.requests.length, 4);
  assert.equal(destinationRequests.length, 6);
});

test('HTTPS mock-forward targets use an authenticated HTTPS-upstream CONNECT tunnel', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-mock-forward-tls-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const destinationCert = await ca.generateCertForHost('127.0.0.1');

  const destinationRequests = [];
  const destination = https.createServer(
    { key: destinationCert.key, cert: destinationCert.cert },
    (request, response) => {
      destinationRequests.push({ url: request.url, headers: { ...request.headers } });
      response.end('secure destination');
    }
  );
  const destroyDestinationSockets = trackSockets(destination);
  const destinationPort = await listen(destination);

  const connects = [];
  const upstream = https.createServer({ key: destinationCert.key, cert: destinationCert.cert });
  upstream.on('connect', (request, clientSocket, head) => {
    connects.push({ authority: request.url, headers: { ...request.headers } });
    const targetSocket = net.connect(destinationPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) targetSocket.write(head);
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
    targetSocket.once('error', () => clientSocket.destroy());
  });
  const destroyUpstreamSockets = trackSockets(upstream);
  const upstreamPort = await listen(upstream);

  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setHttpsWhitelist(['127.0.0.1']);
  proxy.setUpstreamProxy({
    host: '127.0.0.1', port: upstreamPort, type: 'https', auth: 'mock-user:mock-pass'
  });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: { type: 'forward', forwardTo: `https://127.0.0.1:${destinationPort}` }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(upstream, destroyUpstreamSockets);
    await close(destination, destroyDestinationSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const response = await requestH1({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://source.example/secure-target',
    headers: { host: 'source.example' }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'secure destination');
  assert.equal(connects.length, 1);
  assert.equal(connects[0].authority, `127.0.0.1:${destinationPort}`);
  assert.equal(connects[0].headers['proxy-authorization'], PROXY_AUTH);
  assert.equal(destinationRequests.length, 1);
  assert.equal(destinationRequests[0].url, '/secure-target');
  assert.equal(destinationRequests[0].headers['proxy-authorization'], undefined);
});

test('HTTP mock-forward targets retain the established SOCKS connection path', async t => {
  const destinationRequests = [];
  const destination = http.createServer((request, response) => {
    destinationRequests.push(request.url);
    response.end('socks destination');
  });
  const destroyDestinationSockets = trackSockets(destination);
  const destinationPort = await listen(destination);

  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: 1080, type: 'socks5' });
  const socksConnections = [];
  proxy._connectViaSocks = async (hostname, port) => {
    socksConnections.push({ hostname, port });
    const socket = net.connect(port, hostname);
    await once(socket, 'connect');
    return socket;
  };
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: { type: 'forward', forwardTo: `http://127.0.0.1:${destinationPort}` }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(destination, destroyDestinationSockets);
  });

  const response = await requestH1({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://source.example/socks-target',
    headers: { host: 'source.example' }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'socks destination');
  assert.deepEqual(socksConnections, [{ hostname: '127.0.0.1', port: destinationPort }]);
  assert.deepEqual(destinationRequests, ['/socks-target']);
});

test('mock-forward retries remain limited to safe requests and honor upstream timeouts', { timeout: 10000 }, async t => {
  const destinationRequests = [];
  const destination = http.createServer((request, response) => {
    destinationRequests.push(request.url);
    response.end('retry destination');
  });
  const destroyDestinationSockets = trackSockets(destination);
  const destinationPort = await listen(destination);

  const attempts = new Map();
  const upstream = http.createServer((request, response) => {
    const target = new URL(request.url);
    const attempt = (attempts.get(target.pathname) || 0) + 1;
    attempts.set(target.pathname, attempt);
    request.resume();

    if (target.pathname === '/safe-retry' && attempt === 1) {
      request.socket.destroy();
      return;
    }
    if (target.pathname === '/unsafe-no-retry') {
      request.socket.destroy();
      return;
    }
    if (target.pathname === '/timeout') {
      return;
    }

    const destinationRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: request.method,
      headers: { host: target.host }
    }, destinationResponse => {
      response.writeHead(destinationResponse.statusCode, destinationResponse.headers);
      destinationResponse.pipe(response);
    });
    destinationRequest.once('error', error => {
      response.writeHead(502);
      response.end(error.message);
    });
    destinationRequest.end();
  });
  const destroyUpstreamSockets = trackSockets(upstream);
  const upstreamPort = await listen(upstream);

  const retries = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    upstreamRetryDelayMs: 0,
    upstreamIdleTimeoutMs: 50,
    onUpstreamProxyRetry: event => { retries.push(event); }
  });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: { type: 'forward', forwardTo: `http://127.0.0.1:${destinationPort}` }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(upstream, destroyUpstreamSockets);
    await close(destination, destroyDestinationSockets);
  });

  const safeResponse = await requestH1({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://source.example/safe-retry',
    headers: { host: 'source.example' }
  });
  assert.equal(safeResponse.statusCode, 200);
  assert.equal(safeResponse.body, 'retry destination');
  assert.equal(attempts.get('/safe-retry'), 2);
  assert.deepEqual(destinationRequests, ['/safe-retry']);

  const unsafeBody = 'state-changing-body';
  const unsafeResponse = await requestH1({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://source.example/unsafe-no-retry',
    method: 'POST',
    headers: {
      host: 'source.example',
      'content-length': String(Buffer.byteLength(unsafeBody))
    }
  }, unsafeBody);
  assert.equal(unsafeResponse.statusCode, 502);
  assert.match(unsafeResponse.body, /Forward Error:/);
  assert.equal(attempts.get('/unsafe-no-retry'), 1);

  const timeoutResponse = await requestH1({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://source.example/timeout',
    headers: { host: 'source.example' }
  });
  assert.equal(timeoutResponse.statusCode, 502);
  assert.match(timeoutResponse.body, /timeout/i);
  assert.equal(attempts.get('/timeout'), 2);
  assert.equal(retries.length, 2);
});

test('disconnecting a mock-forward client aborts the request through the upstream proxy', async t => {
  let resolveDestinationStarted;
  const destinationStarted = new Promise(resolve => { resolveDestinationStarted = resolve; });
  let resolveDestinationClosed;
  const destinationClosed = new Promise(resolve => { resolveDestinationClosed = resolve; });
  const destination = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    const interval = setInterval(() => response.write('still forwarding\n'), 20);
    response.once('close', () => {
      clearInterval(interval);
      resolveDestinationClosed();
    });
    resolveDestinationStarted();
  });
  const destroyDestinationSockets = trackSockets(destination);
  const destinationPort = await listen(destination);

  let upstreamHits = 0;
  const upstream = http.createServer((request, response) => {
    upstreamHits++;
    const target = new URL(request.url);
    const destinationRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: request.method,
      headers: { host: target.host }
    }, destinationResponse => destinationResponse.pipe(response));
    const abortDestination = () => destinationRequest.destroy();
    request.once('aborted', abortDestination);
    response.once('close', abortDestination);
    destinationRequest.once('error', () => {});
    request.pipe(destinationRequest);
  });
  const destroyUpstreamSockets = trackSockets(upstream);
  const upstreamPort = await listen(upstream);

  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: { type: 'forward', forwardTo: `http://127.0.0.1:${destinationPort}` }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(upstream, destroyUpstreamSockets);
    await close(destination, destroyDestinationSockets);
  });

  const client = http.get({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://source.example/slow-forward',
    headers: { host: 'source.example' }
  });
  client.once('error', () => {});
  await destinationStarted;
  client.destroy();

  assert.equal(
    await Promise.race([
      destinationClosed.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 500))
    ]),
    true,
    'destination response remained open after the mock-forward client disconnected'
  );
  assert.equal(upstreamHits, 1);
});

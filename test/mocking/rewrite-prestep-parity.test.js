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

const requestBody = 'preserved request body';

async function listen(server) {
  server.listen(0);
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

function originHandler(records) {
  return (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const record = {
        method: request.method,
        path: request.url,
        host: request.headers.host,
        before: request.headers['x-before'],
        after: request.headers['x-after'],
        removed: request.headers['x-remove'],
        body: Buffer.concat(chunks).toString('utf8')
      };
      records.push(record);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(record));
    });
  };
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
  const rawSocket = await openTunnel(proxyPort, authority);
  const hostname = new URL(`https://${authority}`).hostname;
  const secureSocket = tls.connect({
    socket: rawSocket,
    servername: net.isIP(hostname) ? undefined : hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function collectHttpResponse(request) {
  return new Promise((resolve, reject) => {
    request.once('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(requestBody);
  });
}

function requestPlain(proxyPort, originalUrl) {
  const target = new URL(originalUrl);
  const request = http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: originalUrl,
    method: 'POST',
    headers: {
      host: target.host,
      connection: 'close',
      'content-length': Buffer.byteLength(requestBody),
      'x-remove': 'remove me'
    }
  });
  return collectHttpResponse(request);
}

function requestWithAgent(agent, authority, requestPath, connection = 'close') {
  const target = new URL(`http://${authority}`);
  const request = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: requestPath,
    method: 'POST',
    agent,
    headers: {
      host: authority,
      connection,
      'content-length': Buffer.byteLength(requestBody),
      'x-remove': 'remove me'
    }
  });
  return collectHttpResponse(request);
}

async function requestInterceptedH1(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const agent = new http.Agent();
  agent.createConnection = () => socket;
  return requestWithAgent(agent, authority, '/original');
}

async function requestInterceptedH2(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  await once(client, 'connect');
  const request = client.request({
    ':method': 'POST',
    ':path': '/original',
    ':authority': authority,
    ':scheme': 'https',
    'content-length': String(Buffer.byteLength(requestBody)),
    'x-remove': 'remove me'
  });
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  const responsePromise = once(request, 'response');
  const endPromise = once(request, 'end');
  request.end(requestBody);
  const [headers] = await responsePromise;
  await endPromise;
  client.close();
  await once(client, 'close');
  return { statusCode: headers[':status'], body: Buffer.concat(chunks).toString('utf8') };
}

function setRewriteRule(proxy, rewriteUrl, forwardTo) {
  proxy.mockRules = [{
    id: 'rewrite-parity',
    enabled: true,
    matchers: [{ type: 'wildcard' }],
    preSteps: [
      { type: 'add-header', name: 'x-before', value: 'present' },
      { type: 'remove-header', name: 'x-remove' },
      { type: 'rewrite-url', value: rewriteUrl },
      { type: 'rewrite-method', value: 'PATCH' },
      { type: 'add-header', name: 'x-after', value: 'present' }
    ],
    action: { type: 'forward', forwardTo }
  }];
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

test('rewrite pre-steps have destination, method, header, and capture parity', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-rewrite-parity-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('localhost');
  const originRecords = [];
  const plainOrigin = http.createServer(originHandler(originRecords));
  const secureOrigin = https.createServer(
    { key: originCert.key, cert: originCert.cert },
    originHandler(originRecords)
  );
  const plainPort = await listen(plainOrigin);
  const securePort = await listen(secureOrigin);

  const captures = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => captures.push(event) });
  proxy.setHttpsWhitelist(['127.0.0.1', 'localhost']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(plainOrigin);
    await close(secureOrigin);
    await rm(dataDir, { recursive: true, force: true });
  });

  const cases = [
    {
      name: 'plain H1 absolute',
      mode: 'disabled',
      forwardTo: `http://127.0.0.1:${plainPort}`,
      rewrite: `http://127.0.0.1:${plainPort}/rewritten?kind=absolute`,
      originalUrl: 'http://original.example.test/original',
      send: () => requestPlain(proxy.server.address().port, 'http://original.example.test/original')
    },
    {
      name: 'intercepted HTTPS H1 absolute',
      mode: 'disabled',
      authority: 'original.example.test:443',
      forwardTo: `https://127.0.0.1:${securePort}`,
      rewrite: `https://127.0.0.1:${securePort}/rewritten?kind=absolute`,
      originalUrl: 'https://original.example.test/original',
      send: () => requestInterceptedH1(proxy.server.address().port, 'original.example.test:443')
    },
    {
      name: 'native H2 absolute',
      mode: 'h2-only',
      authority: 'original.example.test:443',
      forwardTo: `https://127.0.0.1:${securePort}`,
      rewrite: `https://127.0.0.1:${securePort}/rewritten?kind=absolute`,
      originalUrl: 'https://original.example.test/original',
      send: () => requestInterceptedH2(proxy.server.address().port, 'original.example.test:443')
    },
    {
      name: 'H1-on-H2 absolute',
      mode: 'all',
      authority: 'original.example.test:443',
      forwardTo: `https://127.0.0.1:${securePort}`,
      rewrite: `https://127.0.0.1:${securePort}/rewritten?kind=absolute`,
      originalUrl: 'https://original.example.test/original',
      send: () => requestInterceptedH1(proxy.server.address().port, 'original.example.test:443')
    },
    {
      name: 'plain H1 relative',
      mode: 'disabled',
      forwardTo: `http://localhost:${plainPort}`,
      rewrite: '/rewritten?kind=relative',
      expectedUrl: `http://localhost:${plainPort}/rewritten?kind=relative`,
      originalUrl: `http://localhost:${plainPort}/original`,
      send: () => requestPlain(proxy.server.address().port, `http://localhost:${plainPort}/original`)
    },
    {
      name: 'intercepted HTTPS H1 relative',
      mode: 'disabled',
      authority: `localhost:${securePort}`,
      forwardTo: `https://localhost:${securePort}`,
      rewrite: '/rewritten?kind=relative',
      expectedUrl: `https://localhost:${securePort}/rewritten?kind=relative`,
      originalUrl: `https://localhost:${securePort}/original`,
      send: () => requestInterceptedH1(proxy.server.address().port, `localhost:${securePort}`)
    },
    {
      name: 'native H2 relative',
      mode: 'h2-only',
      authority: `localhost:${securePort}`,
      forwardTo: `https://localhost:${securePort}`,
      rewrite: '/rewritten?kind=relative',
      expectedUrl: `https://localhost:${securePort}/rewritten?kind=relative`,
      originalUrl: `https://localhost:${securePort}/original`,
      send: () => requestInterceptedH2(proxy.server.address().port, `localhost:${securePort}`)
    },
    {
      name: 'H1-on-H2 relative',
      mode: 'all',
      authority: `localhost:${securePort}`,
      forwardTo: `https://localhost:${securePort}`,
      rewrite: '/rewritten?kind=relative',
      expectedUrl: `https://localhost:${securePort}/rewritten?kind=relative`,
      originalUrl: `https://localhost:${securePort}/original`,
      send: () => requestInterceptedH1(proxy.server.address().port, `localhost:${securePort}`)
    }
  ];

  for (const scenario of cases) {
    proxy.setHttp2Config(scenario.mode);
    setRewriteRule(proxy, scenario.rewrite, scenario.forwardTo);
    const captureStart = captures.length;
    const response = await scenario.send();
    const originRecord = JSON.parse(response.body);
    const capture = captures.slice(captureStart).findLast(event => event.source === 'mock' && event.statusCode === 200);
    const expectedUrl = scenario.expectedUrl || scenario.rewrite;
    const expectedTarget = new URL(expectedUrl);

    assert.equal(response.statusCode, 200, scenario.name);
    assert.deepEqual(originRecord, {
      method: 'PATCH',
      path: expectedTarget.pathname + expectedTarget.search,
      host: expectedTarget.host,
      before: 'present',
      after: 'present',
      body: requestBody
    }, scenario.name);
    assert.ok(capture, `${scenario.name}: completed capture`);
    assert.equal(capture.method, 'PATCH', scenario.name);
    assert.equal(capture.url, expectedTarget.href, scenario.name);
    assert.equal(capture.path, expectedTarget.pathname + expectedTarget.search, scenario.name);
    assert.equal(getHeader(capture.requestHeaders, 'host'), expectedTarget.host, scenario.name);
    assert.equal(capture.originalRequest.method, 'POST', scenario.name);
    assert.equal(capture.originalRequest.url, scenario.originalUrl, scenario.name);
    assert.equal(capture.requestBody, requestBody, scenario.name);
  }

  proxy.setHttp2Config('disabled');
  proxy.mockRules = [{
    id: 'keep-alive-rewrite',
    enabled: true,
    matchers: [{ type: 'path', matchType: 'exact', value: '/rewrite-once' }],
    preSteps: [
      { type: 'rewrite-url', value: `http://localhost:${plainPort}/rewritten-once` },
      { type: 'rewrite-method', value: 'PATCH' }
    ],
    action: { type: 'forward', forwardTo: `http://localhost:${plainPort}` }
  }];
  const tunnelAuthority = `localhost:${securePort}`;
  const keepAliveSocket = await connectTls(proxy.server.address().port, tunnelAuthority, ['http/1.1']);
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  keepAliveAgent.createConnection = () => keepAliveSocket;
  t.after(() => keepAliveAgent.destroy());

  const rewrittenResponse = await requestWithAgent(
    keepAliveAgent,
    tunnelAuthority,
    '/rewrite-once',
    'keep-alive'
  );
  assert.equal(JSON.parse(rewrittenResponse.body).path, '/rewritten-once');

  const secondCaptureStart = captures.length;
  const untouchedResponse = await requestWithAgent(
    keepAliveAgent,
    tunnelAuthority,
    '/after-rewrite',
    'close'
  );
  const untouchedOrigin = JSON.parse(untouchedResponse.body);
  const untouchedCapture = captures.slice(secondCaptureStart).findLast(event => event._update);

  assert.equal(untouchedResponse.statusCode, 200);
  assert.equal(untouchedOrigin.method, 'POST');
  assert.equal(untouchedOrigin.path, '/after-rewrite');
  assert.equal(untouchedOrigin.host, tunnelAuthority);
  assert.equal(untouchedCapture.url, `https://${tunnelAuthority}/after-rewrite`);
  assert.equal(untouchedCapture.host, 'localhost');
});

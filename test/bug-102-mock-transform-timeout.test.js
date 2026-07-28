import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import zlib from 'node:zlib';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestThroughProxy(proxyPort, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method: options.method || 'GET',
      headers: {
        ...(options.headers || {}),
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function openTunnel(proxyPort, hostname, targetPort = 443) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${hostname}:${targetPort} HTTP/1.1\r\nHost: ${hostname}:${targetPort}\r\n\r\n`
  );
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

async function sendTlsHttp1(proxyPort, hostname, targetPort) {
  const tunnel = await openTunnel(proxyPort, hostname, targetPort);
  const socket = tls.connect({
    socket: tunnel,
    ...(net.isIP(hostname) ? {} : { servername: hostname }),
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(socket, 'secureConnect');
  socket.write(
    `GET /original HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`
  );
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  await once(socket, 'end');
  return Buffer.concat(chunks).toString('utf8');
}

test('transform-request forwards request changes and transforms the upstream response', async t => {
  let received;
  const origin = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const requestBody = Buffer.concat(chunks);
      received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: (request.headers['content-encoding'] === 'gzip'
          ? zlib.gunzipSync(requestBody)
          : requestBody).toString('utf8')
      };
      const body = JSON.stringify({ original: true, keep: 'response' });
      const compressedBody = zlib.gzipSync(body);
      response.writeHead(201, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': compressedBody.length,
        'x-remove-response': 'yes'
      });
      response.end(compressedBody);
    });
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.mockRules = [{
    enabled: true,
    matchers: [{ type: 'method', value: 'POST' }],
    action: {
      type: 'transform-request',
      methodMode: 'PUT',
      urlMode: 'modify',
      urlReplace: `http://127.0.0.1:${originPort}/changed?yes=1`,
      headersMode: 'update',
      headers: { 'x-added-request': 'yes' },
      removeHeaders: ['x-remove-request'],
      bodyMode: 'json-merge',
      body: JSON.stringify({ added: 'request' }),
      resStatusMode: 'replace',
      resStatusOverride: 209,
      resHeadersMode: 'update',
      resHeaders: { 'x-added-response': 'yes' },
      resRemoveHeaders: ['x-remove-response'],
      resBodyMode: 'json-merge',
      resBody: JSON.stringify({ original: false, added: 'response' })
    }
  }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const response = await requestThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/original`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-remove-request': 'yes'
      },
      body: zlib.gzipSync(JSON.stringify({ keep: 'request' }))
    }
  );

  assert.equal(received.method, 'PUT');
  assert.equal(received.url, '/changed?yes=1');
  assert.equal(received.headers['x-added-request'], 'yes');
  assert.equal(received.headers['x-remove-request'], undefined);
  assert.equal(received.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(received.body), { keep: 'request', added: 'request' });
  assert.equal(response.statusCode, 209);
  assert.equal(response.headers['x-added-response'], 'yes');
  assert.equal(response.headers['x-remove-response'], undefined);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(response.body), {
    original: false,
    keep: 'response',
    added: 'response'
  });
});

test('H2 clients receive transformed responses after transformed requests are forwarded',
  { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-transform-h2-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    let received;
    const origin = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        received = {
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString('utf8')
        };
        response.writeHead(202, { 'content-type': 'text/plain', 'x-origin': 'yes' });
        response.end('origin response');
      });
    });
    const originPort = await listen(origin);
    const proxy = new ProxyServer(ca, { port: 0 });
    proxy.setHttp2Config('h2-only');
    proxy.mockRules = [{
      enabled: true,
      matchers: [{ type: 'method', value: 'POST' }],
      action: {
        type: 'transform-request',
        methodMode: 'PATCH',
        urlMode: 'modify',
        urlReplace: `http://127.0.0.1:${originPort}/h2-transformed`,
        bodyMode: 'replace-fixed',
        body: 'transformed request',
        resStatusMode: 'replace',
        resStatusOverride: 207,
        resHeadersMode: 'update',
        resHeaders: { 'x-transformed': 'yes' },
        resRemoveHeaders: ['x-origin'],
        resBodyMode: 'match-replace',
        resBodyMatchPattern: 'origin',
        resBodyReplaceWith: 'transformed'
      }
    }];
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await close(origin);
      await rm(dataDir, { recursive: true, force: true });
    });

    const tunnel = await openTunnel(proxy.server.address().port, 'original.example.test');
    const secureSocket = tls.connect({
      socket: tunnel,
      servername: 'original.example.test',
      ALPNProtocols: ['h2'],
      rejectUnauthorized: false
    });
    await once(secureSocket, 'secureConnect');
    const client = http2.connect('https://original.example.test', {
      createConnection: () => secureSocket
    });
    t.after(() => client.destroy());
    await once(client, 'connect');

    const request = client.request({
      ':method': 'POST',
      ':path': '/original',
      ':authority': 'original.example.test',
      ':scheme': 'https'
    });
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    const responsePromise = once(request, 'response');
    const endPromise = once(request, 'end');
    request.end('original request');
    const [headers] = await responsePromise;
    await endPromise;

    assert.deepEqual(received, {
      method: 'PATCH',
      url: '/h2-transformed',
      body: 'transformed request'
    });
    assert.equal(headers[':status'], 207);
    assert.equal(headers['x-transformed'], 'yes');
    assert.equal(headers['x-origin'], undefined);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'transformed response');
  });

test('intercepted H1 clients can rewrite secure requests to HTTP origins',
  { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-transform-http-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const received = [];
    const origin = http.createServer((request, response) => {
      received.push(request.url);
      response.end('rewritten to http');
    });
    const originPort = await listen(origin);
    t.after(async () => {
      await close(origin);
      await rm(dataDir, { recursive: true, force: true });
    });

    for (const mode of ['disabled', 'all']) {
      await t.test(mode, async t => {
        const proxy = new ProxyServer(ca, { port: 0 });
        proxy.setHttp2Config(mode);
        proxy.mockRules = [{
          enabled: true,
          matchers: [{ type: 'method', value: 'GET' }],
          action: {
            type: 'transform-request',
            urlMode: 'modify',
            urlReplace: `http://127.0.0.1:${originPort}/${mode}`
          }
        }];
        await proxy.start();
        t.after(() => proxy.stop());

        const response = await sendTlsHttp1(
          proxy.server.address().port,
          'original.example.test',
          443
        );

        assert.match(response, /^HTTP\/1\.1 200 /);
        assert.match(response, /rewritten to http$/);
      });
    }

    assert.deepEqual(received, ['/disabled', '/all']);
  });

test('legacy response transforms work for both intercepted H1 TLS routes',
  { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-transform-h1-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const originCertificate = await ca.generateCertForHost('127.0.0.1');
    const origin = https.createServer({
      key: originCertificate.key,
      cert: originCertificate.cert
    }, (_request, response) => {
      response.writeHead(203, {
        'content-type': 'text/plain',
        'x-remove-response': 'yes'
      });
      response.end('legacy original body');
    });
    const originPort = await listen(origin);
    t.after(async () => {
      await close(origin);
      await rm(dataDir, { recursive: true, force: true });
    });

    for (const mode of ['disabled', 'all']) {
      await t.test(mode, async t => {
        const proxy = new ProxyServer(ca, { port: 0 });
        proxy.setHttp2Config(mode);
        proxy.setHttpsWhitelist(['127.0.0.1']);
        proxy.mockRules = [{
          enabled: true,
          matchers: [{ type: 'method', value: 'GET' }],
          action: {
            type: 'transform-response',
            statusOverride: 208,
            headers: { 'x-legacy-transform': mode },
            removeHeaders: ['x-remove-response'],
            bodyMode: 'match-replace',
            bodyMatchPattern: 'original',
            bodyReplaceWith: 'transformed'
          }
        }];
        await proxy.start();
        t.after(() => proxy.stop());

        const response = await sendTlsHttp1(
          proxy.server.address().port,
          '127.0.0.1',
          originPort
        );

        assert.match(response, /^HTTP\/1\.1 208 /);
        assert.match(response.toLowerCase(), new RegExp(`x-legacy-transform: ${mode}`));
        assert.doesNotMatch(response.toLowerCase(), /x-remove-response:/);
        assert.match(response, /legacy transformed body$/);
      });
    }
  });

test('timeout mock actions keep the response pending and never contact the origin', async t => {
  let originHits = 0;
  const origin = http.createServer((_request, response) => {
    originHits += 1;
    response.end('unexpected');
  });
  const originPort = await listen(origin);
  const captured = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: request => captured.push(structuredClone(request))
  });
  proxy.mockRules = [{
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'timeout' }
  }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const request = http.get({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: `http://127.0.0.1:${originPort}/timeout`
  });
  const outcome = new Promise(resolve => {
    request.once('response', () => resolve('response'));
    request.once('error', () => resolve('error'));
  });
  const early = await Promise.race([
    outcome,
    new Promise(resolve => setTimeout(() => resolve('pending'), 150))
  ]);

  assert.equal(early, 'pending');
  assert.equal(originHits, 0);
  const closed = new Promise(resolve => request.once('close', resolve));
  request.destroy();
  await closed;
  const deadline = Date.now() + 1000;
  while (!captured.some(record => record.statusMessage === 'Client Disconnected')
    && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(captured[0].statusMessage, 'Pending');
  const terminal = captured.find(record => record.statusMessage === 'Client Disconnected');
  assert.equal(terminal?.statusCode, 0);
  assert.equal(terminal?.errorCode, 'ERR_DOWNSTREAM_ABORTED');
});

test('timeout captures settle when an H2 client closes with no stream error', () => {
  const captured = [];
  const proxy = new ProxyServer(null, {
    onRequest: request => captured.push(structuredClone(request))
  });
  const stream = new EventEmitter();
  stream.aborted = false;
  stream.closed = false;
  stream.destroyed = false;
  stream.rstCode = http2.constants.NGHTTP2_NO_ERROR;
  const downstream = proxy._trackDownstreamCancellation(stream, { http2Stream: true });

  proxy._holdMockTimeout(downstream, {
    id: 'h2-timeout',
    protocol: 'h2',
    method: 'GET',
    url: 'https://example.test/timeout',
    host: 'example.test',
    path: '/timeout',
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp: Date.now(),
    source: 'mock',
    tls: null,
    remote: null
  });
  stream.closed = true;
  stream.emit('close');

  assert.deepEqual(captured.map(record => record.statusMessage), [
    'Pending',
    'Client Disconnected'
  ]);
  assert.equal(captured[1].errorCode, 'ERR_DOWNSTREAM_ABORTED');
});

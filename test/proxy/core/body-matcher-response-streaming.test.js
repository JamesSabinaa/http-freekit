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

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
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
  const secureSocket = tls.connect({
    socket,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function collectH1(request, body) {
  return new Promise((resolve, reject) => {
    request.once('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function requestPlain(proxyPort, originPort, body) {
  return collectH1(http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: `http://127.0.0.1:${originPort}/large`,
    method: 'POST',
    headers: { connection: 'close', 'content-length': body.length }
  }), body);
}

async function requestInterceptedH1(proxyPort, authority, body) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const agent = new http.Agent();
  agent.createConnection = () => socket;
  try {
    return await collectH1(http.request({
      hostname: '127.0.0.1',
      port: 443,
      path: '/large',
      method: 'POST',
      agent,
      headers: { host: authority, connection: 'close', 'content-length': body.length }
    }), body);
  } finally {
    agent.destroy();
  }
}

async function requestInterceptedH2(proxyPort, authority, body) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  try {
    await once(client, 'connect');
    const request = client.request({
      ':method': 'POST',
      ':path': '/large',
      ':authority': authority,
      ':scheme': 'https',
      'content-length': String(body.length)
    });
    const chunks = [];
    let responseHeaders;
    request.on('data', chunk => chunks.push(chunk));
    request.once('response', headers => { responseHeaders = headers; });
    request.end(body);
    await once(request, 'end');
    return {
      statusCode: responseHeaders[':status'],
      body: Buffer.concat(chunks).toString('utf8')
    };
  } finally {
    client.destroy();
  }
}

for (const requestTransform of [false, true]) {
test(`${requestTransform ? 'request-only transforms' : 'body-matcher misses'} stream oversized responses across every HTTP ingress`,
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-body-miss-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const originCert = await ca.generateCertForHost('127.0.0.1');
    let receivedHeaders;
    const respond = (request, response) => {
      receivedHeaders = request.headers;
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': '9'
      });
      response.end('123456789');
    };
    const plainOrigin = http.createServer(respond);
    const secureOrigin = https.createServer({
      key: originCert.key,
      cert: originCert.cert
    }, respond);
    const plainPort = await listen(plainOrigin);
    const securePort = await listen(secureOrigin);

    const events = [];
    const proxy = new ProxyServer(ca, {
      port: 0,
      maxBufferedBodyBytes: 8,
      onRequest: event => events.push(event)
    });
    proxy.setHttpsWhitelist(['127.0.0.1']);
    proxy.mockRules = requestTransform ? [{
      enabled: true,
      matchers: [],
      action: {
        type: 'transform-request',
        headersMode: 'update',
        headers: { 'x-edited': 'yes' },
        resStatusMode: 'original',
        resHeadersMode: 'original',
        resBodyMode: 'original'
      }
    }] : [{
      enabled: true,
      matchers: [{ type: 'body-contains', value: 'match me' }],
      action: { type: 'fixed-response', status: 200, body: 'unexpected mock' }
    }];
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await close(secureOrigin);
      await close(plainOrigin);
      await rm(dataDir, { recursive: true, force: true });
    });

    const proxyPort = proxy.server.address().port;
    const authority = `127.0.0.1:${securePort}`;
    const body = Buffer.from('miss');
    const protocols = [
      {
        name: 'plain H1',
        mode: 'disabled',
        send: () => requestPlain(proxyPort, plainPort, body)
      },
      {
        name: 'intercepted H1',
        mode: 'disabled',
        send: () => requestInterceptedH1(proxyPort, authority, body)
      },
      {
        name: 'native H2',
        mode: 'h2-only',
        send: () => requestInterceptedH2(proxyPort, authority, body)
      },
      {
        name: 'H1-on-H2 fallback',
        mode: 'all',
        send: () => requestInterceptedH1(proxyPort, authority, body)
      }
    ];

    for (const protocol of protocols) {
      await t.test(protocol.name, async () => {
        proxy.setHttp2Config(protocol.mode);
        const eventStart = events.length;
        assert.deepEqual(await protocol.send(), { statusCode: 200, body: '123456789' });
        if (requestTransform) assert.equal(receivedHeaders['x-edited'], 'yes');
        const capture = events.slice(eventStart).findLast(event =>
          event.path === '/large' && event.statusCode === 200
        );
        assert.ok(capture, 'expected a completed capture');
        assert.equal(capture.responseBodyTruncated, true);
        assert.equal(capture.responseBodyCapturedSize, 0);
        assert.equal(capture.responseBodyDecodedSize, 9);
        assert.equal(capture.responseBodySize, 9);
      });
    }
  });
}

test('request-only transforms deliver SSE events before the origin ends its response', { timeout: 10000 }, async t => {
  let originResponse;
  let originEnded = false;
  const origin = http.createServer((request, response) => {
    assert.equal(request.headers['x-edited'], 'yes');
    originResponse = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: {
      type: 'transform-request', headersMode: 'update', headers: { 'x-edited': 'yes' },
      resStatusMode: 'original', resHeadersMode: 'original', resBodyMode: 'original'
    }
  }];
  await proxy.start();
  const fallback = setTimeout(() => {
    originEnded = true;
    originResponse?.end();
  }, 1500);
  t.after(async () => {
    clearTimeout(fallback);
    originResponse?.end();
    await proxy.stop();
    await close(origin);
  });
  const request = http.get({
    hostname: '127.0.0.1', port: proxy.server.address().port,
    path: `http://127.0.0.1:${originPort}/events`, headers: { connection: 'close' }
  });
  const [response] = await once(request, 'response');
  const [chunk] = await once(response, 'data');
  assert.equal(chunk.toString(), 'data: first\n\n');
  assert.equal(originEnded, false, 'the first event must arrive while the origin response is open');
  const ended = once(response, 'end');
  originResponse.end();
  await ended;
});

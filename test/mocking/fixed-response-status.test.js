import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

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
    servername: new URL(`https://${authority}`).hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function collectH1Response(request) {
  return new Promise((resolve, reject) => {
    const informational = [];
    request.on('information', info => informational.push(info.statusCode));
    request.once('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        addedHeader: response.headers['x-added'],
        informational
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function requestPlain(proxyPort, pathname, method = 'GET') {
  return collectH1Response(http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: `http://final-status.test${pathname}`,
    method,
    headers: { host: 'final-status.test', connection: 'close' }
  }));
}

async function requestInterceptedH1(proxyPort, authority, pathname, method = 'GET') {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const agent = new http.Agent();
  agent.createConnection = () => socket;
  try {
    return await collectH1Response(http.request({
      hostname: 'final-status.test',
      port: 443,
      path: pathname,
      method,
      agent,
      headers: { host: authority, connection: 'close' }
    }));
  } finally {
    agent.destroy();
  }
}

async function requestInterceptedH2(proxyPort, authority, pathname, method = 'GET') {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  try {
    await once(client, 'connect');
    const request = client.request({
      ':method': method,
      ':path': pathname,
      ':authority': authority,
      ':scheme': 'https'
    });
    const chunks = [];
    let responseHeaders;
    request.on('data', chunk => chunks.push(chunk));
    request.once('response', headers => { responseHeaders = headers; });
    request.end();
    await once(request, 'end');
    return {
      statusCode: responseHeaders[':status'],
      headers: responseHeaders,
      body: Buffer.concat(chunks).toString('utf8'),
      addedHeader: responseHeaders['x-added'],
      informational: []
    };
  } finally {
    client.destroy();
  }
}

function fixedRule(id, pathname, status, body) {
  return {
    id,
    enabled: true,
    matchers: [{ type: 'path', matchType: 'exact', value: pathname }],
    action: {
      type: 'fixed-response',
      status,
      headers: { 'content-type': 'text/plain' },
      addResponseHeaders: { 'x-added': 'yes' },
      body
    }
  };
}

test('response transforms cannot replace a final status with an informational status', () => {
  const proxy = new ProxyServer(null);
  const response = {
    statusCode: 204,
    headers: {},
    body: Buffer.alloc(0),
    trailers: {}
  };

  assert.equal(proxy._applyMockResponseTransform({
    type: 'transform-response',
    statusOverride: 199
  }, response).statusCode, 204);
  assert.equal(proxy._applyMockResponseTransform({
    type: 'transform-response',
    statusOverride: 200
  }, response).statusCode, 200);
  assert.equal(proxy._applyMockResponseTransform({
    type: 'transform-response',
    statusOverride: 599
  }, response).statusCode, 599);
});

test('fixed mock responses use final statuses across every H1 and H2 response engine',
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-final-status-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const events = [];
    const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await rm(dataDir, { recursive: true, force: true });
    });

    proxy.mockRules = [
      fixedRule('invalid-informational', '/fallback', 199, 'must not run'),
      fixedRule('valid-fallback', '/fallback', 200, 'safe final response'),
      fixedRule('valid-upper-bound', '/upper-bound', 599, 'upper bound response'),
      fixedRule('head-response', '/head', 200, 'must not be sent for HEAD'),
      fixedRule('no-content', '/no-content', 204, 'must not be sent for 204'),
      fixedRule('not-modified', '/not-modified', 304, 'must not be sent for 304')
    ];
    for (const rule of proxy.mockRules.slice(-3)) {
      rule.action.headers['transfer-encoding'] = 'chunked';
      rule.action.headers['content-length'] = String(Buffer.byteLength(rule.action.body));
    }

    const authority = 'final-status.test:443';
    const protocols = [
      {
        name: 'plain H1 engine',
        mode: 'disabled',
        send: (pathname, method) => requestPlain(proxy.server.address().port, pathname, method)
      },
      {
        name: 'intercepted HTTPS H1 engine',
        mode: 'disabled',
        send: (pathname, method) => requestInterceptedH1(
          proxy.server.address().port, authority, pathname, method
        )
      },
      {
        name: 'native H2 engine',
        mode: 'h2-only',
        send: (pathname, method) => requestInterceptedH2(
          proxy.server.address().port, authority, pathname, method
        )
      },
      {
        name: 'H1-on-H2 fallback engine',
        mode: 'all',
        send: (pathname, method) => requestInterceptedH1(
          proxy.server.address().port, authority, pathname, method
        )
      }
    ];

    for (const protocol of protocols) {
      await t.test(protocol.name, async () => {
        proxy.setHttp2Config(protocol.mode);

        const fallback = await protocol.send('/fallback');
        assert.deepEqual(fallback, {
          statusCode: 200,
          headers: fallback.headers,
          body: 'safe final response',
          addedHeader: 'yes',
          informational: []
        });

        const upperBound = await protocol.send('/upper-bound');
        assert.deepEqual(upperBound, {
          statusCode: 599,
          headers: upperBound.headers,
          body: 'upper bound response',
          addedHeader: 'yes',
          informational: []
        });

        for (const [pathname, method, statusCode] of [
          ['/head', 'HEAD', 200],
          ['/no-content', 'GET', 204],
          ['/not-modified', 'GET', 304]
        ]) {
          const response = await protocol.send(pathname, method);
          assert.equal(response.statusCode, statusCode);
          assert.equal(response.body, '');
          assert.equal(response.headers['transfer-encoding'], undefined);
          if (statusCode === 204) assert.equal(response.headers['content-length'], undefined);
          const capture = events.findLast(event =>
            event.source === 'mock' && event.path === pathname && event.statusCode === statusCode
          );
          assert.ok(capture);
          assert.equal(capture.responseBody, '');
          assert.equal(capture.responseBodySize, 0);
          assert.equal(capture.responseHeaders['transfer-encoding'], undefined);
        }

        for (const rule of proxy.mockRules.slice(0, 3)) {
          assert.deepEqual(rule.action.headers, { 'content-type': 'text/plain' });
        }
        if (protocol.name === 'native H2 engine') {
          const capture = events.findLast(event =>
            event.source === 'mock' && event.protocol === 'h2' && event.path === '/upper-bound'
          );
          assert.equal(capture.responseHeaders['x-added'], 'yes');
          assert.equal(capture.responseHeaders.connection, undefined);
        }
      });
    }
  });

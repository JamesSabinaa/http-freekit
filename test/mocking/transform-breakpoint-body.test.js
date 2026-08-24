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
import zlib from 'node:zlib';

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
  const secureSocket = tls.connect({
    socket,
    servername: new URL(`https://${authority}`).hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function collectH1Response(request, body) {
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

function requestPlain(proxyPort, body, headers) {
  const request = http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: 'http://breakpoint-source.test/original',
    method: 'POST',
    headers: {
      host: 'breakpoint-source.test',
      connection: 'close',
      ...headers,
      'content-length': body.length
    }
  });
  return collectH1Response(request, body);
}

async function requestInterceptedH1(proxyPort, authority, body, headers) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const agent = new http.Agent();
  agent.createConnection = () => socket;
  try {
    const request = http.request({
      hostname: 'breakpoint-source.test',
      port: 443,
      path: '/original',
      method: 'POST',
      agent,
      headers: {
        host: authority,
        connection: 'close',
        ...headers,
        'content-length': body.length
      }
    });
    return await collectH1Response(request, body);
  } finally {
    agent.destroy();
  }
}

async function requestInterceptedH2(proxyPort, authority, body, headers) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  try {
    await once(client, 'connect');
    const request = client.request({
      ':method': 'POST',
      ':path': '/original',
      ':authority': authority,
      ':scheme': 'https',
      ...headers,
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

test('transformed request bodies drive breakpoints across every HTTP ingress protocol',
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-transform-breakpoint-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();

    const received = [];
    const origin = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push({ body, headers: request.headers });
        response.end(`received:${body.length}`);
      });
    });
    const originPort = await listen(origin);

    const breakpointHits = [];
    const captured = [];
    let resumeModifications = {};
    let proxy;
    proxy = new ProxyServer(ca, {
      port: 0,
      onRequest: request => captured.push(request),
      onBreakpoint: event => {
        if (event.type !== 'breakpoint-hit') return;
        breakpointHits.push(event);
        setImmediate(() => {
          const modifications = resumeModifications;
          resumeModifications = {};
          proxy.resumeBreakpoint(
            event.requestId,
            modifications,
            event.trafficLifecycleId
          );
        });
      }
    });
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await close(origin);
      await rm(dataDir, { recursive: true, force: true });
    });

    const breakpointChecks = [];
    const checkBreakpoint = proxy._checkBreakpoint.bind(proxy);
    proxy._checkBreakpoint = (...args) => {
      const rule = checkBreakpoint(...args);
      breakpointChecks.push({ body: args[3], ruleId: rule?.id });
      return rule;
    };

    const authority = 'breakpoint-source.test:443';
    const protocols = [
      {
        name: 'plain H1',
        mode: 'disabled',
        send: (body, headers) => requestPlain(proxy.server.address().port, body, headers)
      },
      {
        name: 'intercepted HTTPS H1',
        mode: 'disabled',
        send: (body, headers) => requestInterceptedH1(
          proxy.server.address().port, authority, body, headers
        )
      },
      {
        name: 'native H2',
        mode: 'h2-only',
        send: (body, headers) => requestInterceptedH2(
          proxy.server.address().port, authority, body, headers
        )
      },
      {
        name: 'H1-on-H2 fallback',
        mode: 'all',
        send: (body, headers) => requestInterceptedH1(
          proxy.server.address().port, authority, body, headers
        )
      }
    ];

    for (const protocol of protocols) {
      await t.test(protocol.name, async () => {
        proxy.setHttp2Config(protocol.mode);

        const runScenario = async ({ input, inputHeaders = {}, transformed, expectedRule }) => {
          proxy.mockRules = [{
            id: 'request-transform-provenance',
            title: 'Request transform provenance',
            enabled: true,
            matchers: [{ type: 'method', value: 'POST' }],
            preSteps: [{ type: 'add-header', name: 'x-pre-step', value: 'applied' }],
            action: {
              type: 'transform-request',
              urlMode: 'modify',
              urlReplace: `http://127.0.0.1:${originPort}/transformed`,
              bodyMode: 'replace-fixed',
              body: transformed
            }
          }];
          proxy.breakpointRules = [
            {
              id: 'original-body',
              enabled: true,
              matchers: [{ type: 'raw-body-exact', value: 'before transform' }]
            },
            {
              id: expectedRule,
              enabled: true,
              matchers: [{ type: 'raw-body-exact', value: transformed }]
            }
          ];

          const checkStart = breakpointChecks.length;
          const hitStart = breakpointHits.length;
          const receivedStart = received.length;
          const captureStart = captured.length;
          const response = await protocol.send(input, inputHeaders);

          assert.equal(response.statusCode, 200);
          assert.equal(breakpointChecks.length, checkStart + 1);
          assert.deepEqual(breakpointChecks[checkStart], {
            body: transformed,
            ruleId: expectedRule
          });
          assert.equal(breakpointHits.length, hitStart + 1);
          assert.equal(received.length, receivedStart + 1);
          assert.equal(received[receivedStart].body.toString('utf8'), transformed);
          assert.equal(received[receivedStart].headers['x-pre-step'], 'applied');
          assert.equal(received[receivedStart].headers['content-encoding'], undefined);
          const completedCapture = captured.slice(captureStart)
            .findLast(item => item.method === 'POST' && item.statusCode === 200);
          assert.ok(completedCapture);
          assert.equal(completedCapture.requestBody, transformed);
          assert.equal(completedCapture.requestBodyEncoding, 'utf8');
          assert.equal(Object.hasOwn(
            completedCapture,
            'requestBodyContentDecoded'
          ), false);
          assert.equal(completedCapture.requestHeaders['content-encoding'], undefined);
          assert.equal(completedCapture.originalRequest.method, 'POST');
          assert.equal(String(completedCapture.originalRequest.body), 'before transform');
          assert.equal(completedCapture.originalRequest.headers['x-pre-step'], undefined);
          assert.equal(completedCapture.transformedBy, 'Request transform provenance');
        };

        await runScenario({
          input: zlib.gzipSync('before transform'),
          inputHeaders: { 'content-encoding': 'gzip' },
          transformed: 'after transform',
          expectedRule: 'replacement-body'
        });
        await runScenario({
          input: Buffer.from('before transform'),
          transformed: '',
          expectedRule: 'removed-body'
        });

        const decodedBody = `buffered gzip capture for ${protocol.name}`;
        const breakpointEditedBody = `breakpoint edit for ${protocol.name}`;
        const compressedBody = zlib.gzipSync(decodedBody);
        proxy.mockRules = [];
        proxy.breakpointRules = [{
          id: 'decoded-gzip-body',
          enabled: true,
          matchers: [{ type: 'body-contains', value: decodedBody }]
        }];
        resumeModifications = {
          url: `http://127.0.0.1:${originPort}/buffered-gzip`,
          body: breakpointEditedBody
        };
        const captureStart = captured.length;
        const response = await protocol.send(compressedBody, {
          'content-encoding': 'gzip',
          'content-type': 'text/plain; charset=utf-8'
        });

        assert.equal(response.statusCode, 200);
        const requestCaptures = captured.slice(captureStart).filter(item => item.method === 'POST');
        assert.ok(requestCaptures.length >= 2, 'expected pending and completed captures');
        const pendingCapture = requestCaptures.find(item => item.statusCode === 0);
        const completedCapture = requestCaptures.findLast(item => item.statusCode === 200);
        assert.ok(pendingCapture);
        assert.ok(completedCapture);
        assert.equal(pendingCapture.requestBody, decodedBody);
        assert.equal(pendingCapture.requestBodyContentDecoded, true);
        assert.equal(completedCapture.requestBody, breakpointEditedBody);
        assert.equal(completedCapture.requestBodyEncoding, 'utf8');
        assert.equal(completedCapture.requestHeaders['content-encoding'], undefined);
        assert.equal(received.at(-1).body.toString('utf8'), breakpointEditedBody);
        assert.equal(received.at(-1).headers['content-encoding'], undefined);
      });
    }
  });

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

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for webhook activity');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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
  secureSocket.on('error', () => {});
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

function requestPlain(proxyPort, body, extraHeaders = {}) {
  const url = 'http://webhook-source.test/original';
  const request = http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: url,
    method: 'POST',
    headers: {
      host: 'webhook-source.test',
      connection: 'close',
      'content-type': 'text/original',
      ...extraHeaders,
      'content-length': Buffer.byteLength(body)
    }
  });
  return collectH1Response(request, body);
}

async function requestInterceptedH1(proxyPort, authority, body, extraHeaders = {}) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  const agent = new http.Agent();
  agent.createConnection = () => socket;
  try {
    const request = http.request({
      hostname: 'webhook-source.test',
      port: 443,
      path: '/original',
      method: 'POST',
      agent,
      headers: {
        host: authority,
        connection: 'close',
        'content-type': 'text/original',
        ...extraHeaders,
        'content-length': Buffer.byteLength(body)
      }
    });
    return await collectH1Response(request, body);
  } finally {
    agent.destroy();
  }
}

async function requestInterceptedH2(proxyPort, authority, body, extraHeaders = {}) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  try {
    await once(client, 'connect');
    const request = client.request({
      ':method': 'POST',
      ':path': '/original',
      ':authority': authority,
      ':scheme': 'https',
      'content-type': 'text/original',
      ...extraHeaders,
      'content-length': String(Buffer.byteLength(body))
    });
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let responseHeaders = null;
      let settled = false;
      const settle = callback => {
        if (settled) return;
        settled = true;
        callback();
      };
      const fail = error => settle(() => reject(error));
      request.on('data', chunk => chunks.push(chunk));
      request.once('response', headers => { responseHeaders = headers; });
      request.once('end', () => settle(() => resolve({
        statusCode: responseHeaders?.[':status'],
        body: Buffer.concat(chunks).toString('utf8')
      })));
      request.once('aborted', () => fail(new Error('HTTP/2 request aborted')));
      request.once('error', fail);
      client.once('error', fail);
      client.once('close', () => fail(new Error('HTTP/2 session closed before the response')));
      socket.once('close', () => fail(new Error('TLS connection closed before the response')));
      request.end(body);
    });
  } finally {
    client.destroy();
  }
}

function captureWebhookRequest(records, statusCode) {
  return (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      records.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks)
      });
      response.writeHead(statusCode);
      response.end();
    });
  };
}

async function createProxy(t, onRequest) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-webhook-parity-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const proxy = new ProxyServer(ca, { port: 0, onRequest });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { proxy, ca };
}

test('webhook mocks have success and failure parity across every HTTP ingress protocol',
  { timeout: 30000 }, async t => {
    const deliveries = [];
    const captures = [];
    const { proxy, ca } = await createProxy(t, event => captures.push(event));
    const webhookCertificate = await ca.generateCertForHost('127.0.0.1');
    const successWebhook = https.createServer({
      key: webhookCertificate.key,
      cert: webhookCertificate.cert
    }, captureWebhookRequest(deliveries, 204));
    const failureWebhook = http.createServer(captureWebhookRequest(deliveries, 503));
    const successPort = await listen(successWebhook);
    const failurePort = await listen(failureWebhook);
    proxy.setTrustedCAs([ca.caCertPath]);
    t.after(async () => {
      await close(successWebhook);
      await close(failureWebhook);
    });

    const authority = 'webhook-source.test:443';
    const protocols = [
      {
        name: 'plain H1',
        mode: 'disabled',
        protocol: 'http',
        expectedUrl: 'http://webhook-source.test/rewritten?via=webhook',
        send: (body, headers) => requestPlain(proxy.server.address().port, body, headers)
      },
      {
        name: 'intercepted HTTPS H1',
        mode: 'disabled',
        protocol: 'https',
        expectedUrl: 'https://webhook-source.test/rewritten?via=webhook',
        send: (body, headers) => requestInterceptedH1(
          proxy.server.address().port, authority, body, headers
        )
      },
      {
        name: 'native H2',
        mode: 'h2-only',
        protocol: 'h2',
        expectedUrl: 'https://webhook-source.test/rewritten?via=webhook',
        send: (body, headers) => requestInterceptedH2(
          proxy.server.address().port, authority, body, headers
        )
      },
      {
        name: 'H1-on-H2',
        mode: 'all',
        protocol: 'https',
        expectedUrl: 'https://webhook-source.test/rewritten?via=webhook',
        send: (body, headers) => requestInterceptedH1(
          proxy.server.address().port, authority, body, headers
        )
      }
    ];
    const outcomes = [
      {
        name: 'success',
        webhookUrl: `https://127.0.0.1:${successPort}/success`,
        statusCode: 200,
        statusMessage: 'Webhook sent'
      },
      {
        name: 'failure',
        webhookUrl: `http://127.0.0.1:${failurePort}/failure`,
        statusCode: 502,
        statusMessage: 'Webhook delivery failed',
        error: 'Webhook endpoint responded with HTTP 503'
      }
    ];

    for (const outcome of outcomes) {
      for (const protocol of protocols) {
        const body = zlib.gzipSync(`${outcome.name}-${protocol.protocol}`);
        proxy.setHttp2Config(protocol.mode);
        proxy.mockRules = [{
          enabled: true,
          matchers: [],
          preSteps: [
            { type: 'delay', ms: 5 },
            { type: 'rewrite-method', value: 'PATCH' },
            { type: 'rewrite-url', value: '/rewritten?via=webhook' },
            { type: 'add-header', name: 'content-type', value: 'text/transformed' }
          ],
          action: {
            type: 'webhook',
            webhookUrl: outcome.webhookUrl,
            webhookHeaders: { 'x-webhook-rule': 'applied' },
            delay: 5
          }
        }];
        const deliveryStart = deliveries.length;
        const captureStart = captures.length;

        const response = await protocol.send(body, { 'content-encoding': 'gzip' });
        assert.equal(response.statusCode, 200, `${outcome.name} ${protocol.name}`);
        assert.equal(response.body, '', `${outcome.name} ${protocol.name}`);
        await waitFor(() => deliveries.length === deliveryStart + 1);
        await waitFor(() => captures.slice(captureStart).some(
          event => event.statusMessage === outcome.statusMessage
        ));

        const delivery = deliveries[deliveryStart];
        assert.equal(delivery.method, 'POST', protocol.name);
        assert.equal(delivery.path, `/${outcome.name}`, protocol.name);
        assert.deepEqual(delivery.body, body, protocol.name);
        assert.equal(delivery.headers['content-type'], 'text/transformed', protocol.name);
        assert.equal(delivery.headers['content-encoding'], 'gzip', protocol.name);
        assert.equal(delivery.headers['x-forwarded-method'], 'PATCH', protocol.name);
        assert.equal(delivery.headers['x-forwarded-url'], protocol.expectedUrl, protocol.name);
        assert.equal(delivery.headers['x-forwarded-host'], 'webhook-source.test', protocol.name);
        assert.equal(delivery.headers['x-webhook-rule'], 'applied', protocol.name);

        const finalCaptures = captures.slice(captureStart).filter(
          event => event.statusMessage === outcome.statusMessage
        );
        assert.equal(finalCaptures.length, 1, `${outcome.name} ${protocol.name} finalizes once`);
        assert.equal(finalCaptures[0].protocol, protocol.protocol, protocol.name);
        assert.equal(finalCaptures[0].source, 'mock', protocol.name);
        assert.equal(finalCaptures[0].mockResponseSource, undefined, protocol.name);
        assert.equal(finalCaptures[0].statusCode, outcome.statusCode, protocol.name);
        assert.equal(finalCaptures[0].method, 'PATCH', protocol.name);
        assert.equal(finalCaptures[0].url, protocol.expectedUrl, protocol.name);
        assert.equal(finalCaptures[0].error, outcome.error, protocol.name);
      }
    }
  });

test('close mocks apply their action delay across every HTTP ingress protocol',
  { timeout: 30000 }, async t => {
    const waitCalls = [];
    const captures = [];
    const { proxy } = await createProxy(t, event => captures.push({
      event,
      completedDelayCount: waitCalls.filter(call => call.completed).length
    }));
    const waitForMockDelay = proxy._waitForMockDelay.bind(proxy);
    proxy._waitForMockDelay = async (milliseconds, preparation) => {
      const call = { milliseconds, completed: false };
      waitCalls.push(call);
      const result = await waitForMockDelay(milliseconds, preparation);
      call.completed = true;
      return result;
    };

    const authority = 'close-delay.test:443';
    const protocols = [
      {
        name: 'plain H1',
        mode: 'disabled',
        protocol: 'http',
        send: body => requestPlain(proxy.server.address().port, body)
      },
      {
        name: 'intercepted HTTPS H1',
        mode: 'disabled',
        protocol: 'https',
        send: body => requestInterceptedH1(proxy.server.address().port, authority, body)
      },
      {
        name: 'native H2',
        mode: 'h2-only',
        protocol: 'h2',
        send: body => requestInterceptedH2(proxy.server.address().port, authority, body)
      },
      {
        name: 'H1-on-H2',
        mode: 'all',
        protocol: 'https',
        send: body => requestInterceptedH1(proxy.server.address().port, authority, body)
      }
    ];

    for (const protocol of protocols) {
      proxy.setHttp2Config(protocol.mode);
      proxy.mockRules = [{
        enabled: true,
        matchers: [],
        action: { type: 'close', delay: 20 }
      }];
      const waitStart = waitCalls.length;
      const captureStart = captures.length;

      await protocol.send(`close-${protocol.protocol}`).catch(() => {});
      await waitFor(() => captures.slice(captureStart).some(
        capture => capture.event.statusMessage === 'Connection Closed'
      ));
      const terminal = captures.slice(captureStart).find(
        capture => capture.event.statusMessage === 'Connection Closed'
      );

      const protocolWaits = waitCalls.slice(waitStart);
      assert.equal(protocolWaits.length, 1, `${protocol.name}: one action delay`);
      assert.equal(protocolWaits[0].milliseconds, 20, protocol.name);
      assert.equal(protocolWaits[0].completed, true, protocol.name);
      assert.equal(terminal.completedDelayCount, waitStart + 1,
        `${protocol.name}: delay completed before terminal capture`);
      assert.equal(terminal.event.protocol, protocol.protocol, protocol.name);
      assert.equal(terminal.event.statusCode, 0, protocol.name);
    }
  });

test('shutdown cancels a delayed native H2 webhook without delivering it',
  { timeout: 20000 }, async t => {
    let deliveryCount = 0;
    const webhook = http.createServer((request, response) => {
      deliveryCount++;
      request.resume();
      response.writeHead(204);
      response.end();
    });
    const webhookPort = await listen(webhook);
    t.after(() => close(webhook));

    const { proxy } = await createProxy(t, () => {});
    proxy.setHttp2Config('h2-only');
    proxy.mockRules = [{
      enabled: true,
      matchers: [],
      preSteps: [{ type: 'delay', ms: 5000 }],
      action: {
        type: 'webhook',
        webhookUrl: `http://127.0.0.1:${webhookPort}/late`
      }
    }];

    const response = requestInterceptedH2(
      proxy.server.address().port,
      'webhook-shutdown.test:443',
      'payload'
    ).catch(error => error);
    await waitFor(() => proxy._pendingWebhookPreparations.size === 1);
    await proxy.stop();
    await response;
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(deliveryCount, 0);
    assert.equal(proxy._pendingWebhookPreparations.size, 0);
    assert.equal(proxy._activeWebhookRequests.size, 0);
    assert.equal(proxy._pendingWebhookFinalizations.size, 0);
  });

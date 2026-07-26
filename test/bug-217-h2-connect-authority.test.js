import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

async function openTunnel(proxyPort, authority) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\n` +
    `Host: ${authority}\r\n\r\n`
  );

  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /);
  return socket;
}

async function startH2MockProxy(t, connectAuthority, servername) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-authority-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();

  const events = [];
  const proxy = new ProxyServer(ca, { onRequest: event => events.push(event) });
  proxy.port = 0;
  proxy.setHttp2Config('h2-only');
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: { type: 'fixed-response', status: 200, body: 'matched' }
  }];

  let matcherCalls = 0;
  let breakpointCalls = 0;
  const findMockRule = proxy._findMockRule.bind(proxy);
  const checkBreakpoint = proxy._checkBreakpoint.bind(proxy);
  proxy._findMockRule = (...args) => {
    matcherCalls++;
    return findMockRule(...args);
  };
  proxy._checkBreakpoint = (...args) => {
    breakpointCalls++;
    return checkBreakpoint(...args);
  };

  await proxy.start();
  const tunnel = await openTunnel(proxy.server.address().port, connectAuthority);
  const secureSocket = tls.connect({
    socket: tunnel,
    ...(servername ? { servername } : {}),
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');

  const client = http2.connect(`https://${connectAuthority}`, {
    createConnection: () => secureSocket
  });
  await once(client, 'connect');

  t.after(async () => {
    client.destroy();
    await proxy.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    client,
    events,
    getMatcherCalls: () => matcherCalls,
    getBreakpointCalls: () => breakpointCalls
  };
}

async function makeRequest(client, headers) {
  const request = client.request({ ':method': 'GET', ':path': '/', ...headers });
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  const responsePromise = once(request, 'response');
  const endPromise = once(request, 'end');
  request.end();
  const [responseHeaders] = await responsePromise;
  await endPromise;
  return {
    status: responseHeaders[':status'],
    body: Buffer.concat(chunks).toString('utf8')
  };
}

test('CONNECT H2 rejects a different authority or scheme before matching and capture', { timeout: 20000 }, async t => {
  const context = await startH2MockProxy(t, 'origin.example:443', 'origin.example');

  assert.deepEqual(await makeRequest(context.client, {
    ':authority': 'other.example',
    ':scheme': 'https'
  }), { status: 421, body: 'Misdirected Request' });
  assert.deepEqual(await makeRequest(context.client, {
    ':authority': 'origin.example',
    ':scheme': 'http'
  }), { status: 421, body: 'Misdirected Request' });

  assert.equal(context.getMatcherCalls(), 0);
  assert.equal(context.getBreakpointCalls(), 0);
  assert.deepEqual(context.events, []);

  assert.deepEqual(await makeRequest(context.client, {
    ':authority': 'ORIGIN.EXAMPLE:443',
    ':scheme': 'https',
    ':path': '/accepted',
    host: 'other.example'
  }), { status: 200, body: 'matched' });
  assert.equal(context.getMatcherCalls(), 1);
  assert.deepEqual(context.events.map(event => [event.url, event.host]), [
    ['https://origin.example/accepted', 'origin.example'],
    ['https://origin.example/accepted', 'origin.example']
  ]);
  assert.deepEqual(context.events.map(event => event.requestHeaders.host), [
    'origin.example',
    'origin.example'
  ]);
});

test('CONNECT H2 accepts equivalent bracketed IPv6 authorities and captures the canonical origin', { timeout: 20000 }, async t => {
  const context = await startH2MockProxy(t, '[::1]:443');

  assert.deepEqual(await makeRequest(context.client, {
    ':authority': '[0:0:0:0:0:0:0:1]:443',
    ':scheme': 'https',
    ':path': '/ipv6'
  }), { status: 200, body: 'matched' });
  assert.deepEqual(context.events.map(event => [event.url, event.host]), [
    ['https://[::1]/ipv6', '[::1]'],
    ['https://[::1]/ipv6', '[::1]']
  ]);

  assert.deepEqual(await makeRequest(context.client, {
    ':authority': '[::2]',
    ':scheme': 'https'
  }), { status: 421, body: 'Misdirected Request' });
  assert.equal(context.events.length, 2);
});

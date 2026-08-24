import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

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
    servername: authority.split(':')[0],
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

async function abortPlainH1(proxyPort, authority) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `GET http://${authority}/buffered-abort HTTP/1.1\r\n` +
    `Host: ${authority}\r\nConnection: close\r\n\r\n`
  );
  await new Promise(resolve => setTimeout(resolve, 25));
  socket.destroy();
}

async function abortInterceptedH1(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  socket.write(
    `GET /buffered-abort HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`
  );
  await new Promise(resolve => setTimeout(resolve, 25));
  socket.destroy();
}

async function abortInterceptedH2(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  await once(client, 'connect');
  const request = client.request({
    ':method': 'GET',
    ':path': '/buffered-abort',
    ':authority': authority,
    ':scheme': 'https'
  });
  request.on('error', () => {});
  request.end();
  await new Promise(resolve => setTimeout(resolve, 25));
  request.close(http2.constants.NGHTTP2_CANCEL);
  await new Promise(resolve => setTimeout(resolve, 25));
  client.destroy();
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal capture');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('buffered downstream disconnects terminalize once across every HTTP ingress',
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-buffered-abort-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const events = [];
    const proxy = new ProxyServer(ca, {
      port: 0,
      onRequest: event => events.push(structuredClone(event))
    });
    proxy.setTlsFingerprint('passthrough');
    proxy.mockRules = [{
      enabled: true,
      matchers: [],
      action: {
        type: 'fixed-response',
        status: 209,
        body: 'must not be captured',
        delay: 200
      }
    }];
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await rm(dataDir, { recursive: true, force: true });
    });

    const proxyPort = proxy.server.address().port;
    const authority = 'buffered-abort.test:443';
    const scenarios = [
      { name: 'plain H1', mode: 'disabled', send: abortPlainH1 },
      { name: 'intercepted H1', mode: 'disabled', send: abortInterceptedH1 },
      { name: 'native H2', mode: 'h2-only', send: abortInterceptedH2 },
      { name: 'H1-on-H2', mode: 'all', send: abortInterceptedH1 }
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        events.length = 0;
        proxy.setHttp2Config(scenario.mode);
        await scenario.send(proxyPort, authority);
        await waitFor(
          () => events.some(event => event.statusMessage === 'Client Disconnected')
        ).catch(error => {
          error.message += `; events=${JSON.stringify(events)}`;
          throw error;
        });
        await new Promise(resolve => setTimeout(resolve, 250));

        const completed = events.filter(event => event._pending !== true);
        assert.equal(completed.length, 1, 'one terminal event');
        assert.equal(completed[0].statusCode, 0);
        assert.equal(completed[0].statusMessage, 'Client Disconnected');
        assert.equal(completed[0].errorCode, 'ERR_DOWNSTREAM_ABORTED');
        assert.equal(completed[0].errorPhase, 'downstream');
        assert.equal(events.some(event => event.statusCode === 209), false);
        assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
      });
    }
  });

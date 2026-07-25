import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function readHeaders(socket) {
  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  return response;
}

for (const http2Mode of ['disabled', 'all']) {
test(`secure WebSocket upgrades traverse TLS interception in ${http2Mode} mode`, { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-wss-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  let originUpgrades = 0;
  const origin = https.createServer({ key: originCert.key, cert: originCert.cert });
  origin.on('upgrade', (request, socket) => {
    originUpgrades++;
    const accept = crypto.createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    setTimeout(() => socket.end(), 25);
  });
  const originPort = await listen(origin);

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  proxy.setHttp2Config(http2Mode);
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = net.connect(proxy.server.address().port, '127.0.0.1');
  await once(tunnel, 'connect');
  tunnel.write(
    `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n\r\n`
  );
  const connectResponse = await readHeaders(tunnel);
  assert.match(connectResponse.toString('latin1'), /^HTTP\/1\.1 200 /);

  const secureSocket = tls.connect({
    socket: tunnel,
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  secureSocket.write(
    'GET /socket HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
  const upgradeResponse = await readHeaders(secureSocket);
  assert.match(upgradeResponse.toString('latin1'), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(originUpgrades, 1);

  await once(secureSocket, 'close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1)?.protocol, 'wss');
});
}

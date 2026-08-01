import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function openTunnel(proxyPort, hostname) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /);
  return socket;
}

test('captured H1 TLS metadata reflects the completed TLS 1.3 handshake', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-tls-details-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: { type: 'fixed-response', status: 200, headers: {}, body: 'ok' }
  }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, 'example.test');
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'example.test',
    ALPNProtocols: ['http/1.1'],
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const responseComplete = new Promise(resolve => {
    let response = '';
    secureSocket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (response.includes('ok')) resolve();
    });
  });
  secureSocket.write(
    'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n'
  );
  await responseComplete;
  secureSocket.destroy();

  const completed = events.find(event => event.statusMessage === 'Mocked');
  assert.equal(completed?.tls?.version, 'TLSv1.3');
  assert.equal(typeof completed?.tls?.cipher, 'string');
  assert.notEqual(completed.tls.cipher.length, 0);
});

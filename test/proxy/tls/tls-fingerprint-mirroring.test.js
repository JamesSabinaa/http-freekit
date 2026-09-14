import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { trackClientHellos } from 'read-tls-client-hello';
import { isSupported as isTlsImpersonationSupported } from 'tls-impersonate';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function listen(server, hostname = 'localhost') {
  server.listen(0, hostname);
  await once(server, 'listening');
  return server.address().port;
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
  return socket;
}

async function requestOverTls(connectOptions, hostHeader) {
  const socket = tls.connect({
    ...connectOptions,
    servername: 'localhost',
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(socket, 'secureConnect');

  let response = '';
  socket.on('data', chunk => { response += chunk.toString('utf8'); });
  const ended = once(socket, 'end');
  socket.write(
    'GET /fingerprint HTTP/1.1\r\n' +
    `Host: ${hostHeader}\r\n` +
    'Connection: close\r\n\r\n'
  );
  await ended;
  socket.destroy();
  return response;
}

function supportsExactJa4Mirroring() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return isTlsImpersonationSupported() && (major > 26 || (major === 26 && minor >= 4));
}

test('passthrough interception preserves the inbound JA4 fingerprint upstream', {
  timeout: 30000
}, async t => {
  if (!supportsExactJa4Mirroring()) {
    t.skip('exact JA4 mirroring requires a supported Node.js 26.4+ runtime');
    return;
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-tls-mirror-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCertificate = await ca.generateCertForHost('localhost');
  const receivedHellos = [];
  const origin = https.createServer({
    key: originCertificate.key,
    cert: originCertificate.cert
  }, (request, response) => {
    receivedHellos.push(request.socket.tlsClientHello);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('fingerprint-ok');
  });
  trackClientHellos(origin);
  const originPort = await listen(origin);

  let upstreamConnects = 0;
  const upstream = http.createServer();
  upstream.on('connect', (request, clientSocket, head) => {
    upstreamConnects++;
    const separator = request.url.lastIndexOf(':');
    const hostname = request.url.slice(0, separator);
    const port = Number(request.url.slice(separator + 1));
    const targetSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) targetSocket.write(head);
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
    targetSocket.on('error', () => clientSocket.destroy());
  });
  const upstreamPort = await listen(upstream, '127.0.0.1');

  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setTlsFingerprint('passthrough');
  proxy.setHttpsWhitelist(['localhost']);
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => origin.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const directResponse = await requestOverTls({ host: 'localhost', port: originPort }, 'localhost');
  assert.match(directResponse, /fingerprint-ok/);
  const directHello = receivedHellos.at(-1);
  assert.equal(typeof directHello?.ja4, 'string');

  const tunnel = await openTunnel(
    proxy.server.address().port,
    `localhost:${originPort}`
  );
  const interceptedResponse = await requestOverTls({ socket: tunnel }, 'localhost');
  assert.match(interceptedResponse, /fingerprint-ok/);
  const mirroredHello = receivedHellos.at(-1);

  assert.equal(mirroredHello?.ja4, directHello.ja4);

  const alternateTls = {
    ciphers: [
      'TLS_AES_256_GCM_SHA384',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256'
    ].join(':')
  };
  await requestOverTls({ host: 'localhost', port: originPort, ...alternateTls }, 'localhost');
  const alternateDirectHello = receivedHellos.at(-1);
  assert.notEqual(alternateDirectHello.ja4, directHello.ja4);

  const alternateTunnel = await openTunnel(
    proxy.server.address().port,
    `localhost:${originPort}`
  );
  await requestOverTls({ socket: alternateTunnel, ...alternateTls }, 'localhost');
  const alternateMirroredHello = receivedHellos.at(-1);

  assert.equal(receivedHellos.length, 4);
  assert.equal(alternateMirroredHello.ja4, alternateDirectHello.ja4);
  assert.equal(upstreamConnects, 2);
  proxy.mockRules = [{ enabled: true, matchers: [], action: {
    type: 'forward', forwardTo: `https://localhost:${originPort}`
  } }];
  for (const viaUpstream of [true, false]) {
    if (!viaUpstream) proxy.setUpstreamProxy(null);
    const forwardTunnel = await openTunnel(proxy.server.address().port, `localhost:${originPort}`);
    const forwarded = await requestOverTls({ socket: forwardTunnel, ...alternateTls }, 'localhost');
    assert.match(forwarded, /fingerprint-ok/);
    assert.equal(receivedHellos.at(-1).ja4, alternateDirectHello.ja4);
  }
  assert.equal(upstreamConnects, 3);
});

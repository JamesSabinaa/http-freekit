import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import test from 'node:test';
import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

async function startProxy(t, mode, body) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();

  const events = [];
  const proxy = new ProxyServer(ca, { onRequest: event => events.push(event) });
  proxy.port = 0;
  proxy.setHttp2Config(mode);
  proxy.setTlsFingerprint('passthrough');
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: {
      type: 'fixed-response',
      status: 200,
      body,
      headers: {
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(body))
      }
    }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { proxy, events };
}

async function openTunnel(proxyPort, hostname) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${hostname}:443 HTTP/1.1\r\n` +
    `Host: ${hostname}:443\r\n\r\n`
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

async function connectTls(proxyPort, hostname, protocols) {
  const socket = await openTunnel(proxyPort, hostname);
  const secureSocket = tls.connect({
    socket,
    servername: hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

test('parses HTTP/2 requests after an intercepted CONNECT tunnel', { timeout: 20000 }, async (t) => {
  const { proxy, events } = await startProxy(t, 'h2-only', 'h2-ok');
  const hostname = 'example.test';
  const secureSocket = await connectTls(
    proxy.server.address().port,
    hostname,
    ['h2']
  );
  assert.equal(secureSocket.alpnProtocol, 'h2');

  const client = http2.connect(`https://${hostname}`, {
    createConnection: () => secureSocket
  });
  t.after(() => client.destroy());
  await once(client, 'connect');

  const req = client.request({
    ':method': 'GET',
    ':path': '/',
    ':authority': hostname,
    ':scheme': 'https'
  });
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  const responsePromise = once(req, 'response');
  const endPromise = once(req, 'end');
  req.end();

  const [headers] = await responsePromise;
  await endPromise;
  client.close();
  await once(client, 'close');

  assert.equal(headers[':status'], 200);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'h2-ok');
  assert.deepEqual(events.map(event => [event.protocol, event.statusMessage]), [
    ['h2', 'Pending'],
    ['h2', 'Mocked']
  ]);
});

test('HTTP/2 all mode still accepts HTTP/1.1 via ALPN fallback', { timeout: 20000 }, async (t) => {
  const { proxy, events } = await startProxy(t, 'all', 'h1-ok');
  const hostname = 'example.test';
  const secureSocket = await connectTls(
    proxy.server.address().port,
    hostname,
    ['http/1.1']
  );
  assert.equal(secureSocket.alpnProtocol, 'http/1.1');

  secureSocket.write(
    `GET / HTTP/1.1\r\n` +
    `Host: ${hostname}\r\n` +
    'Connection: close\r\n\r\n'
  );
  const chunks = [];
  secureSocket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  await once(secureSocket, 'end');
  const response = Buffer.concat(chunks).toString('utf8');

  assert.match(response, /^HTTP\/1\.1 200 OK/);
  assert.match(response, /\r\n\r\nh1-ok$/);
  assert.deepEqual(events.map(event => [event.protocol, event.statusMessage]), [
    ['https', 'Pending'],
    ['https', 'Mocked']
  ]);
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function openTunnel(proxyPort, hostname, port = 443) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  return socket;
}

test('H2 breakpoint method and URL edits reach the edited origin', { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-edit-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  const origin = http2.createSecureServer({ key: originCert.key, cert: originCert.cert });
  origin.on('stream', (stream, headers) => {
    const body = `${headers[':method']} ${headers[':path']} ${headers[':authority']}`;
    stream.respond({ ':status': 200, 'content-length': String(Buffer.byteLength(body)) });
    stream.end(body);
  });
  const originPort = await listen(origin);

  const captures = [];
  let proxy;
  proxy = new ProxyServer(ca, {
    onRequest: event => captures.push(event),
    port: 0,
    onBreakpoint: (event) => {
      if (event.type !== 'breakpoint-hit') return;
      setImmediate(() => {
        proxy.resumeBreakpoint(event.requestId, {
          method: 'pOsT',
          url: `https://127.0.0.1:${originPort}/edited?yes=1`
        });
      });
    }
  });
  proxy.setHttp2Config('h2-only');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  proxy.breakpointRules = [{ id: 'edit-h2', enabled: true, matchers: [] }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const rawSocket = await openTunnel(proxy.server.address().port, 'original.example.test');
  const secureSocket = tls.connect({
    socket: rawSocket,
    servername: 'original.example.test',
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const client = http2.connect('https://original.example.test', { createConnection: () => secureSocket });
  t.after(() => client.destroy());
  await once(client, 'connect');

  const request = client.request({
    ':method': 'GET',
    ':path': '/original',
    ':authority': 'original.example.test',
    ':scheme': 'https'
  });
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.end();
  await once(request, 'end');

  const editedAuthority = `127.0.0.1:${originPort}`;
  assert.equal(Buffer.concat(chunks).toString('utf8'), `pOsT /edited?yes=1 ${editedAuthority}`);
  assert.equal(captures.at(-1).url, `https://${editedAuthority}/edited?yes=1`);
  assert.equal(captures.at(-1).host, editedAuthority);
});

test('live H2 response breakpoints strip connection-specific edited headers', { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-response-edit-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const cert = await ca.generateCertForHost('127.0.0.1');
  const origin = http2.createSecureServer({ key: cert.key, cert: cert.cert });
  let originHits = 0;
  origin.on('stream', stream => {
    originHits++;
    stream.respond({ ':status': 200 });
    stream.end('origin response');
  });
  const originPort = await listen(origin);
  const captures = [];
  const hits = [];
  const proxy = new ProxyServer(ca, {
    port: 0,
    onRequest: event => captures.push(event),
    onBreakpoint: event => {
      if (event.type !== 'breakpoint-hit') return;
      hits.push(event);
      setImmediate(() => proxy.resumeBreakpoint(event.requestId, {
        status: 202,
        headers: {
          connection: 'x-remove',
          'keep-alive': 'timeout=5',
          'x-remove': 'nominated',
          'x-safe': 'yes'
        },
        body: 'safe response'
      }));
    }
  });
  proxy.setHttp2Config('h2-only');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  proxy.mockRules = [{ enabled: true, matchers: [], action: { type: 'breakpoint-response' } }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const rawSocket = await openTunnel(proxy.server.address().port, '127.0.0.1', originPort);
  const secureSocket = tls.connect({ socket: rawSocket, ALPNProtocols: ['h2'], rejectUnauthorized: false });
  await once(secureSocket, 'secureConnect');
  const client = http2.connect(`https://127.0.0.1:${originPort}`, { createConnection: () => secureSocket });
  t.after(() => client.destroy());
  await once(client, 'connect');
  const request = client.request({ ':path': '/' });
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  const response = once(request, 'response');
  request.end();
  const [headers] = await response;
  await once(request, 'end');

  assert.equal(originHits, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].phase, 'response');
  assert.equal(headers[':status'], 202);
  assert.equal(headers['content-length'], '13');
  assert.equal(Buffer.concat(chunks).toString(), 'safe response');
  for (const actual of [headers, captures.at(-1).responseHeaders]) {
    assert.equal(actual.connection, undefined);
    assert.equal(actual['keep-alive'], undefined);
    assert.equal(actual['x-remove'], undefined);
    assert.equal(actual['x-safe'], 'yes');
  }
});

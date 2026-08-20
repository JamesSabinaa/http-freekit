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

import { getExtensionData, trackClientHellos } from 'read-tls-client-hello';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

const CHROME_LIKE_SETTINGS = Object.freeze({
  headerTableSize: 65536,
  enablePush: false,
  initialWindowSize: 6291456,
  maxHeaderListSize: 262144
});
const CHROME_LIKE_CONNECTION_WINDOW = 15728640;

async function listen(server, hostname = '127.0.0.1') {
  server.listen(0, hostname);
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
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

async function requestH2({
  port,
  path: requestPath,
  socket = undefined,
  pseudoHeaderOrder = [':method', ':path', ':scheme', ':authority']
}) {
  const secureSocket = tls.connect({
    ...(socket ? { socket } : { host: 'localhost', port }),
    servername: 'localhost',
    ALPNProtocols: ['h2', 'http/1.1'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const session = http2.connect(`https://localhost:${port}`, {
    settings: CHROME_LIKE_SETTINGS,
    createConnection: () => secureSocket
  });
  await once(session, 'connect');
  session.setLocalWindowSize(CHROME_LIKE_CONNECTION_WINDOW);

  const pseudoHeaderValues = {
    ':method': 'GET',
    ':authority': `localhost:${port}`,
    ':scheme': 'https',
    ':path': requestPath
  };
  const requestHeaders = Object.create(null);
  for (const name of pseudoHeaderOrder) requestHeaders[name] = pseudoHeaderValues[name];
  requestHeaders['user-agent'] = 'HTTP FreeKit H2 fingerprint test';
  const stream = session.request(requestHeaders);
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  const responsePromise = once(stream, 'response');
  const endPromise = once(stream, 'end');
  stream.end();
  const [headers] = await responsePromise;
  await endPromise;
  session.close();
  await once(session, 'close');
  return { headers, body: Buffer.concat(chunks).toString('utf8') };
}

test('HTTP/2 interception preserves H2 through an upstream CONNECT proxy', {
  timeout: 30000
}, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-upstream-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const certificate = await ca.generateCertForHost('localhost');
  const observations = new Map();
  const settingsBySession = new WeakMap();
  const origin = http2.createSecureServer({
    key: certificate.key,
    cert: certificate.cert
  });
  trackClientHellos(origin);
  origin.on('session', session => {
    settingsBySession.set(session, session.remoteSettings);
    session.on('remoteSettings', settings => settingsBySession.set(session, settings));
  });
  origin.on('stream', (stream, headers) => {
    observations.set(headers[':path'], {
      ja4: stream.session.socket.tlsClientHello?.ja4,
      alpn: getExtensionData(stream.session.socket.tlsClientHello, 'alpn')?.protocols,
      settings: settingsBySession.get(stream.session),
      connectionWindowSize: stream.session.state?.remoteWindowSize,
      headerOrder: Object.keys(headers)
    });
    if (headers[':path'] === '/cancel-before-headers') {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('h2-upstream-ok');
  });
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
  const upstreamPort = await listen(upstream);

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  proxy.setHttp2Config('h2-only');
  proxy.setTlsFingerprint('passthrough');
  proxy.setHttpsWhitelist(['localhost']);
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(upstream);
    await close(origin);
    await rm(dataDir, { recursive: true, force: true });
  });

  const direct = await requestH2({ port: originPort, path: '/direct' });
  assert.equal(direct.headers[':status'], 200);

  const tunnel = await openTunnel(
    proxy.server.address().port,
    `localhost:${originPort}`
  );
  const intercepted = await requestH2({
    port: originPort,
    path: '/intercepted',
    socket: tunnel
  });
  assert.equal(intercepted.headers[':status'], 200);
  assert.equal(intercepted.body, 'h2-upstream-ok');

  const directObservation = observations.get('/direct');
  const interceptedObservation = observations.get('/intercepted');
  assert.equal(upstreamConnects, 1);
  assert.equal(interceptedObservation.ja4, directObservation.ja4);
  assert.deepEqual(interceptedObservation.alpn, directObservation.alpn);
  assert.deepEqual(interceptedObservation.alpn, ['h2', 'http/1.1']);
  assert.deepEqual(
    interceptedObservation.settings,
    directObservation.settings
  );
  assert.equal(
    interceptedObservation.connectionWindowSize,
    directObservation.connectionWindowSize
  );
  assert.deepEqual(interceptedObservation.headerOrder, directObservation.headerOrder);
  assert.deepEqual(
    interceptedObservation.headerOrder.slice(0, 4),
    [':method', ':path', ':scheme', ':authority']
  );
  const completed = events.find(event => event.path === '/intercepted' && event.statusCode === 200);
  assert.equal(completed?.protocol, 'h2');
  assert.equal(completed?.usedUpstreamProxy, true);

  const cancelled = await requestH2({
    port: originPort,
    path: '/cancel-before-headers',
    socket: await openTunnel(proxy.server.address().port, `localhost:${originPort}`)
  });
  assert.equal(cancelled.headers[':status'], 502);
  const failed = events.find(event =>
    event.path === '/cancel-before-headers' && event.statusCode === 502
  );
  assert.equal(failed?.usedUpstreamProxy, true);
  assert.equal(failed?.upstreamProxyGeneration, proxy._upstreamProxyGeneration);
});

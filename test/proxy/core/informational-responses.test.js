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

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

const EARLY_LINK = '</early.css>; rel=preload; as=style';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
}

function close(server, destroySockets) {
  destroySockets?.();
  return new Promise(resolve => server.close(resolve));
}

async function openTunnel(proxyPort, targetPort) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${targetPort}\r\n\r\n`
  );

  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length) socket.unshift(remaining);
  return socket;
}

async function connectTls(proxyPort, targetPort, protocols) {
  const socket = await openTunnel(proxyPort, targetPort);
  const secureSocket = tls.connect({
    socket,
    servername: 'localhost',
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function requestH1(options) {
  return new Promise((resolve, reject) => {
    const informational = [];
    const request = http.request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        informational,
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('information', info => informational.push(info));
    request.once('error', reject);
    request.end();
  });
}

async function requestH1ThroughTunnel(proxyPort, targetPort, protocols = ['http/1.1']) {
  const socket = await connectTls(proxyPort, targetPort, protocols);
  assert.equal(socket.alpnProtocol, 'http/1.1');
  const response = new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`
  );
  const raw = await response;
  const earlyEnd = raw.indexOf('\r\n\r\n');
  assert.notEqual(earlyEnd, -1, raw);
  const earlyBlock = raw.slice(0, earlyEnd);
  const finalStart = earlyEnd + 4;
  const finalEnd = raw.indexOf('\r\n\r\n', finalStart);
  assert.notEqual(finalEnd, -1, raw);
  const finalBlock = raw.slice(finalStart, finalEnd);
  const headerValue = (block, name) => {
    const match = block.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
    return match?.[1];
  };
  const rawBody = raw.slice(finalEnd + 4);
  const decodeChunked = (body) => {
    const chunks = [];
    let offset = 0;
    while (offset < body.length) {
      const lineEnd = body.indexOf('\r\n', offset);
      assert.notEqual(lineEnd, -1, body);
      const size = Number.parseInt(body.slice(offset, lineEnd).split(';', 1)[0], 16);
      assert.ok(Number.isSafeInteger(size) && size >= 0, body);
      offset = lineEnd + 2;
      if (size === 0) break;
      chunks.push(body.slice(offset, offset + size));
      offset += size + 2;
    }
    return chunks.join('');
  };
  const body = /(?:^|\r\n)transfer-encoding:\s*chunked(?:\r\n|$)/i.test(finalBlock)
    ? decodeChunked(rawBody)
    : rawBody;
  return {
    informational: [{
      statusCode: Number(earlyBlock.match(/^HTTP\/1\.1 (\d{3})/)?.[1]),
      headers: {
        link: headerValue(earlyBlock, 'link'),
        'x-early-source': headerValue(earlyBlock, 'x-early-source')
      }
    }],
    statusCode: Number(finalBlock.match(/^HTTP\/1\.1 (\d{3})/)?.[1]),
    headers: {},
    body
  };
}

async function requestH2ThroughTunnel(proxyPort, targetPort) {
  const socket = await connectTls(proxyPort, targetPort, ['h2']);
  assert.equal(socket.alpnProtocol, 'h2');
  const session = http2.connect(`https://127.0.0.1:${targetPort}`, {
    createConnection: () => socket
  });
  await once(session, 'connect');
  try {
    const request = session.request({
      ':method': 'GET',
      ':path': '/',
      ':scheme': 'https',
      ':authority': `127.0.0.1:${targetPort}`
    });
    const informational = [];
    const chunks = [];
    request.on('headers', headers => informational.push(headers));
    request.on('data', chunk => chunks.push(chunk));
    const responsePromise = once(request, 'response');
    const endPromise = once(request, 'end');
    request.end();
    const [headers] = await responsePromise;
    await endPromise;
    return {
      informational,
      statusCode: headers[':status'],
      headers,
      body: Buffer.concat(chunks).toString('utf8')
    };
  } finally {
    session.close();
    await once(session, 'close');
  }
}

function assertEarlyHints(result, source) {
  assert.deepEqual(result.informational.map(info => info.statusCode ?? info[':status']), [103]);
  assert.equal(result.informational[0].headers?.link ?? result.informational[0].link, EARLY_LINK);
  assert.equal(result.informational[0].headers?.['x-early-source'] ?? result.informational[0]['x-early-source'], source);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, `${source}-final`);
}

async function withProxy(ca, mode, targetPort, callback) {
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config(mode);
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  try {
    return await callback(proxy);
  } finally {
    await proxy.stop();
  }
}

test('forwards 103 Early Hints through every H1/H2 proxy combination', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-info-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');

  const h1Handler = (request, response) => {
    response.writeEarlyHints({ link: EARLY_LINK, 'x-early-source': 'h1' });
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '8' });
    response.end('h1-final');
  };
  const h1Origin = https.createServer({ key: originCert.key, cert: originCert.cert }, h1Handler);
  const destroyH1Sockets = trackSockets(h1Origin);
  const h1Port = await listen(h1Origin);

  const h2Origin = http2.createSecureServer({ key: originCert.key, cert: originCert.cert });
  h2Origin.on('stream', stream => {
    stream.additionalHeaders({
      ':status': 103,
      link: EARLY_LINK,
      'x-early-source': 'h2'
    });
    stream.respond({ ':status': 200, 'content-type': 'text/plain', 'content-length': '8' });
    stream.end('h2-final');
  });
  const destroyH2Sockets = trackSockets(h2Origin);
  const h2Port = await listen(h2Origin);

  t.after(async () => {
    await close(h1Origin, destroyH1Sockets);
    await close(h2Origin, destroyH2Sockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const plainOrigin = http.createServer((request, response) => {
    response.writeEarlyHints({ link: EARLY_LINK, 'x-early-source': 'h1' });
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '8' });
    response.end('h1-final');
  });
  const destroyPlainSockets = trackSockets(plainOrigin);
  const plainPort = await listen(plainOrigin);
  t.after(() => close(plainOrigin, destroyPlainSockets));

  const plainProxy = new ProxyServer(null, { port: 0 });
  await plainProxy.start();
  try {
    assertEarlyHints(await requestH1({
      hostname: '127.0.0.1',
      port: plainProxy.server.address().port,
      path: `http://127.0.0.1:${plainPort}/`,
      headers: { Host: `127.0.0.1:${plainPort}` }
    }), 'h1');
  } finally {
    await plainProxy.stop();
  }

  await withProxy(ca, 'disabled', h1Port, async proxy => {
    proxy._h2Blacklist.add(`127.0.0.1:${h1Port}`);
    assertEarlyHints(await requestH1ThroughTunnel(proxy.server.address().port, h1Port), 'h1');
  });

  await withProxy(ca, 'disabled', h2Port, async proxy => {
    assertEarlyHints(await requestH1ThroughTunnel(proxy.server.address().port, h2Port), 'h2');
  });

  await withProxy(ca, 'all', h1Port, async proxy => {
    proxy._h2Blacklist.add(`127.0.0.1:${h1Port}`);
    assertEarlyHints(await requestH1ThroughTunnel(proxy.server.address().port, h1Port), 'h1');
  });

  await withProxy(ca, 'all', h2Port, async proxy => {
    assertEarlyHints(await requestH1ThroughTunnel(proxy.server.address().port, h2Port), 'h2');
  });

  await withProxy(ca, 'h2-only', h1Port, async proxy => {
    proxy._h2Blacklist.add(`127.0.0.1:${h1Port}`);
    assertEarlyHints(await requestH2ThroughTunnel(proxy.server.address().port, h1Port), 'h1');
  });

  await withProxy(ca, 'h2-only', h2Port, async proxy => {
    assertEarlyHints(await requestH2ThroughTunnel(proxy.server.address().port, h2Port), 'h2');
  });
});

test('does not duplicate Node automatic 100 Continue responses', async t => {
  const origin = http.createServer();
  origin.on('checkContinue', (request, response) => {
    response.writeContinue();
    request.resume();
    request.on('end', () => response.end('continued'));
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
  });

  const informational = [];
  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/`,
      method: 'POST',
      headers: { Expect: '100-continue', 'Content-Length': '4' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('information', info => informational.push(info.statusCode));
    request.on('continue', () => request.end('body'));
    request.on('error', reject);
    request.flushHeaders();
  });

  assert.deepEqual(informational, [100]);
  assert.deepEqual(result, { statusCode: 200, body: 'continued' });
});

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

const HOSTNAME = 'upload.test';
const PARTIAL_BODY = 'partial-upload';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRecord(events, requestPath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = events.find(event => event.path === requestPath);
    if (record) return record;
    await delay(10);
  }
  throw new Error(`Timed out waiting for traffic record ${requestPath}`);
}

async function openTunnel(proxyPort) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${HOSTNAME}:443 HTTP/1.1\r\n` +
    `Host: ${HOSTNAME}:443\r\n\r\n`
  );

  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length > 0) socket.unshift(remaining);
  return socket;
}

async function connectTls(proxyPort, protocols) {
  const socket = await openTunnel(proxyPort);
  const secureSocket = tls.connect({
    socket,
    servername: HOSTNAME,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function endPartialH1Request(socket, requestPath, absoluteUrl = false) {
  const target = absoluteUrl ? `http://${HOSTNAME}${requestPath}` : requestPath;
  socket.end(
    `POST ${target} HTTP/1.1\r\n` +
    `Host: ${HOSTNAME}\r\n` +
    'Content-Type: text/plain\r\n' +
    'Content-Length: 1000\r\n\r\n' +
    PARTIAL_BODY
  );
}

function assertSingleAbort(events, requestPath, protocol) {
  const records = events.filter(event => event.path === requestPath);
  assert.equal(records.length, 1, `${requestPath} emitted more than one traffic record`);
  assert.deepEqual(records[0], {
    ...records[0],
    protocol,
    requestBody: PARTIAL_BODY,
    requestBodySize: Buffer.byteLength(PARTIAL_BODY),
    requestBodyTruncated: true,
    requestBodyCapturedSize: Buffer.byteLength(PARTIAL_BODY),
    requestBodyDecodedSize: 1000,
    statusCode: 0,
    statusMessage: 'Client Upload Aborted',
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    error: 'Client disconnected before completing the request body',
    errorCode: 'ERR_REQUEST_BODY_ABORTED',
    errorPhase: 'request-body'
  });
  assert.equal(records[0]._pending, undefined);
  assert.equal(records[0]._update, undefined);
}

test('an aborted oversized upload omits cleared body data without concatenating it', () => {
  let record;
  const proxy = new ProxyServer(null, {
    maxBufferedBodyBytes: 8,
    onRequest: event => { record = event; }
  });
  const collector = proxy._createBodyCollector();
  proxy._appendBodyChunk(collector, Buffer.from('12345'));
  proxy._appendBodyChunk(collector, Buffer.from('6789'));
  assert.equal(collector.exceeded, true);
  assert.equal(collector.chunks.length, 0);

  proxy._concatBody = () => {
    assert.fail('an exceeded collector must not be concatenated');
  };
  proxy._emitIncompleteUpload({
    id: 'oversized-abort',
    protocol: 'http',
    method: 'POST',
    url: 'http://upload.test/oversized',
    host: HOSTNAME,
    path: '/oversized',
    requestHeaders: {},
    timestamp: Date.now(),
    source: 'proxy',
    tls: null,
    remote: null
  }, collector, 17);

  assert.equal(record.requestBody, '[Request body omitted after exceeding 8 bytes]');
  assert.equal(record.requestBodySize, 17);
  assert.equal(record.requestBodyTruncated, true);
  assert.equal(record.requestBodyCapturedSize, 0);
  assert.equal(record.requestBodyDecodedSize, -1);
  assert.equal(record.statusMessage, 'Client Upload Aborted');
});

test('client-aborted uploads are captured once across every inbound protocol', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-aborted-upload-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  proxy.setTlsFingerprint('passthrough');
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const proxyPort = proxy.server.address().port;

  const plainSocket = net.connect(proxyPort, '127.0.0.1');
  await once(plainSocket, 'connect');
  endPartialH1Request(plainSocket, '/plain-h1', true);
  await waitForRecord(events, '/plain-h1');

  proxy.setHttp2Config('disabled');
  const interceptedH1 = await connectTls(proxyPort, ['http/1.1']);
  assert.equal(interceptedH1.alpnProtocol, 'http/1.1');
  endPartialH1Request(interceptedH1, '/intercepted-h1');
  await waitForRecord(events, '/intercepted-h1');

  proxy.setHttp2Config('h2-only');
  const h2Socket = await connectTls(proxyPort, ['h2']);
  const h2Client = http2.connect(`https://${HOSTNAME}`, { createConnection: () => h2Socket });
  h2Client.on('error', () => {});
  t.after(() => h2Client.destroy());
  await once(h2Client, 'connect');
  const h2Request = h2Client.request({
    ':method': 'POST',
    ':path': '/native-h2',
    ':authority': HOSTNAME,
    ':scheme': 'https',
    'content-type': 'text/plain',
    'content-length': '1000'
  });
  h2Request.on('error', () => {});
  await new Promise(resolve => h2Request.write(PARTIAL_BODY, resolve));
  h2Request.close(http2.constants.NGHTTP2_CANCEL);
  await waitForRecord(events, '/native-h2');

  proxy.setHttp2Config('all');
  const fallbackH1 = await connectTls(proxyPort, ['http/1.1']);
  assert.equal(fallbackH1.alpnProtocol, 'http/1.1');
  endPartialH1Request(fallbackH1, '/h1-on-h2');
  await waitForRecord(events, '/h1-on-h2');

  // Let the aborted/error/close event sequences finish before checking idempotency.
  await delay(100);
  assertSingleAbort(events, '/plain-h1', 'http');
  assertSingleAbort(events, '/intercepted-h1', 'https');
  assertSingleAbort(events, '/native-h2', 'h2');
  assertSingleAbort(events, '/h1-on-h2', 'https');
});

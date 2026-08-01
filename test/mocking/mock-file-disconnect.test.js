import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import tls from 'node:tls';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToHar } from '../../src/api/har-converter.js';
import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

const FILE_STATUS = 206;
const FILE_SIZE = 16 * 1024 * 1024;

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
  const bodyOffset = response.indexOf('\r\n\r\n') + 4;
  if (bodyOffset < response.length) socket.unshift(response.subarray(bodyOffset));
  return socket;
}

async function connectTls(proxyPort, authority, protocols) {
  const socket = await openTunnel(proxyPort, authority);
  const hostname = new URL(`https://${authority}`).hostname;
  const secureSocket = tls.connect({
    socket,
    servername: net.isIP(hostname) ? undefined : hostname,
    ALPNProtocols: protocols,
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  return secureSocket;
}

function abortPlainH1(proxyPort) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: 'http://mock-file.test/resource'
    }, response => {
      response.once('error', () => {});
      response.once('data', chunk => {
        const statusCode = response.statusCode;
        response.destroy();
        request.destroy();
        resolve({ statusCode, receivedBytes: chunk.length });
      });
    });
    request.once('error', error => {
      if (!request.destroyed) reject(error);
    });
    request.end();
  });
}

async function abortInterceptedH1(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['http/1.1']);
  socket.write(`GET /resource HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    socket.once('error', reject);
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd === -1 || response.length === headerEnd + 4) return;
      const statusCode = Number(response.toString('latin1', 0, headerEnd).match(/^HTTP\/1\.1 (\d+)/)?.[1]);
      const receivedBytes = response.length - headerEnd - 4;
      socket.removeAllListeners('data');
      socket.destroy();
      resolve({ statusCode, receivedBytes });
    });
  });
}

async function abortH2(proxyPort, authority) {
  const socket = await connectTls(proxyPort, authority, ['h2']);
  const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
  client.on('error', () => {});
  await once(client, 'connect');

  const request = client.request({
    ':method': 'GET',
    ':path': '/resource',
    ':authority': authority,
    ':scheme': 'https'
  });
  request.on('error', () => {});
  let statusCode;
  request.once('response', headers => { statusCode = headers[':status']; });
  const requestClosed = once(request, 'close');
  const receivedBytes = await new Promise(resolve => {
    request.once('data', chunk => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      resolve(chunk.length);
    });
    request.end();
  });
  await requestClosed;
  client.close();
  return { statusCode, receivedBytes };
}

function attachTraffic(proxy) {
  const api = new ApiServer(proxy, null, null);
  const events = [];
  api._broadcast = () => {};
  proxy.onRequest = event => {
    events.push(structuredClone(event));
    api.onTrafficEvent(event);
  };
  return {
    api,
    events,
    reset() {
      api.trafficLog = [];
      api._pendingTrafficIds.clear();
      api._clearedPendingTrafficIds.clear();
      events.length = 0;
    }
  };
}

async function waitForRecord(capture, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (capture.api.trafficLog[0]?.statusMessage !== 'Client Disconnected') {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for disconnected mock-file traffic: ${JSON.stringify(capture.events)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return capture.api.trafficLog[0];
}

test('mock-file early closes retain delivery progress across plain H1, intercepted H1, and native H2',
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-file-disconnect-'));
    const filePath = path.join(dataDir, 'large-file.txt');
    await writeFile(filePath, Buffer.alloc(FILE_SIZE, 0x61));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const proxy = new ProxyServer(ca, { port: 0 });
    proxy.setTlsFingerprint('passthrough');
    proxy.mockRules = [{
      enabled: true,
      matchers: [],
      action: { type: 'serve-file', filePath, contentType: 'text/plain', status: FILE_STATUS }
    }];
    const capture = attachTraffic(proxy);
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await rm(dataDir, { recursive: true, force: true });
    });

    const authority = 'mock-file-disconnect.test:443';
    const scenarios = [
      { name: 'plain H1', mode: 'disabled', send: port => abortPlainH1(port) },
      { name: 'intercepted H1', mode: 'disabled', send: port => abortInterceptedH1(port, authority) },
      { name: 'native H2', mode: 'h2-only', send: port => abortH2(port, authority) }
    ];

    for (const scenario of scenarios) {
      capture.reset();
      proxy.setHttp2Config(scenario.mode);
      const wire = await scenario.send(proxy.server.address().port);
      assert.equal(wire.statusCode, FILE_STATUS, `${scenario.name}: configured status reached the client`);
      assert.ok(wire.receivedBytes > 0, `${scenario.name}: client received file bytes before closing`);

      const record = await waitForRecord(capture);
      assert.equal(capture.api.trafficLog.length, 1, `${scenario.name}: one logical traffic record`);
      assert.equal(capture.events.filter(event => !event._pending).length, 1,
        `${scenario.name}: one terminal traffic event`);
      assert.equal(record.statusCode, FILE_STATUS, `${scenario.name}: configured status retained`);
      assert.equal(record.statusMessage, 'Client Disconnected', scenario.name);
      assert.equal(record.error, 'Downstream client disconnected', scenario.name);
      assert.equal(record.errorCode, 'ERR_DOWNSTREAM_ABORTED', scenario.name);
      assert.ok(record.responseBodySize > 0 && record.responseBodySize < FILE_SIZE,
        `${scenario.name}: partial byte progress retained`);
      assert.equal(record.responseBody.length, record.responseBodySize,
        `${scenario.name}: streamed partial bytes retained in capture`);
      assert.equal(record.responseBodyTruncated, true, scenario.name);
      assert.equal(record.responseBodyCapturedSize, record.responseBodySize, scenario.name);
      assert.equal(record.responseBodyDecodedSize, FILE_SIZE, scenario.name);

      const harResponse = trafficToHar([record], { maskSensitive: false })
        .log.entries[0].response;
      assert.equal(harResponse.content._capturedSize, record.responseBodySize, scenario.name);
      assert.equal(harResponse.content._originalSize, FILE_SIZE, scenario.name);
      assert.match(
        harResponse.content.comment,
        new RegExp(`${record.responseBodySize} of ${FILE_SIZE} bytes retained`),
        scenario.name
      );
    }
  });

test('mock-file streaming preserves the first failure cause', async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-file-source-error-'));
  const filePath = path.join(tempDir, 'source.txt');
  await writeFile(filePath, 'source');
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const proxy = new ProxyServer(null);
  const originalCreateReadStream = fs.createReadStream;
  const sourceError = Object.assign(new Error('mock source read failed'), { code: 'EIO' });
  fs.createReadStream = () => {
    let started = false;
    const source = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push('partial');
        setImmediate(() => this.destroy(sourceError));
      }
    });
    queueMicrotask(() => source.emit('open', 1));
    return source;
  };

  try {
    const destination = new Writable({ write(_chunk, _encoding, callback) { setImmediate(callback); } });
    const downstream = proxy._trackDownstreamCancellation(destination);
    const error = await proxy._streamMockFile(filePath, destination, () => {}, { downstream })
      .then(() => assert.fail('source failure should reject'), failure => failure);
    assert.equal(error, sourceError);
    assert.equal(error.code, 'EIO');
    const failure = proxy._mockFileFailure(filePath, FILE_STATUS, 'text/plain', error);
    assert.equal(failure.statusCode, FILE_STATUS);
    assert.equal(failure.statusMessage, 'File Delivery Error');
    assert.equal(failure.responseBody, 'partial');
    assert.notEqual(failure.errorCode, 'ERR_DOWNSTREAM_ABORTED');
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }

  const alreadyClosed = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const downstream = proxy._trackDownstreamCancellation(alreadyClosed);
  alreadyClosed.destroy();
  const error = await proxy._streamMockFile(filePath, alreadyClosed, () => assert.fail('headers must not start'), {
    downstream
  }).then(() => assert.fail('closed destination should reject'), failure => failure);
  const failure = proxy._mockFileFailure(filePath, FILE_STATUS, 'text/plain', error);
  assert.equal(failure.statusCode, 0);
  assert.equal(failure.statusMessage, 'Client Disconnected');
  assert.equal(failure.responseBody, '');
  assert.equal(failure.errorCode, 'ERR_DOWNSTREAM_ABORTED');
});

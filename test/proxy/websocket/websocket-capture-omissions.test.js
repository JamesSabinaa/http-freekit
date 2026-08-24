import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import zlib from 'node:zlib';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';
import {
  DEFAULT_MAX_WS_FRAME_PAYLOAD,
  WS_OPCODE
} from '../../../src/proxy/ws-frame-parser.js';

const DEFLATE_TAIL_LENGTH = 4;

function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function encodeFrame(payload, { compressed = false, masked = false } = {}) {
  const data = Buffer.from(payload);
  const extendedLength = data.length < 126 ? 0 : 2;
  const header = Buffer.alloc(2 + extendedLength + (masked ? 4 : 0));
  header[0] = 0x80 | (compressed ? 0x40 : 0) | WS_OPCODE.TEXT;
  let offset = 2;
  if (extendedLength === 0) header[1] = data.length | (masked ? 0x80 : 0);
  else {
    header[1] = 126 | (masked ? 0x80 : 0);
    header.writeUInt16BE(data.length, offset);
    offset += 2;
  }
  if (!masked) return Buffer.concat([header, data]);

  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  mask.copy(header, offset);
  const encoded = Buffer.from(data);
  for (let index = 0; index < encoded.length; index++) encoded[index] ^= mask[index & 3];
  return Buffer.concat([header, encoded]);
}

function compressMessage(message) {
  const encoded = zlib.deflateRawSync(Buffer.from(message), {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH
  });
  return encoded.subarray(0, Math.max(0, encoded.length - DEFLATE_TAIL_LENGTH));
}

async function createWebSocketPair(t, { extension = null, onRequest } = {}) {
  const originSockets = new Set();
  let upgradedSocket;
  const origin = net.createServer(socket => {
    originSockets.add(socket);
    socket.once('close', () => originSockets.delete(socket));
    let handshake = Buffer.alloc(0);
    const onData = chunk => {
      handshake = Buffer.concat([handshake, chunk]);
      if (!handshake.includes(Buffer.from('\r\n\r\n'))) return;
      socket.removeListener('data', onData);
      upgradedSocket = socket;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        (extension ? `Sec-WebSocket-Extensions: ${extension}\r\n` : '') +
        '\r\n'
      );
    };
    socket.on('data', onData);
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');

  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: event => {
      events.push(event);
      onRequest?.(event);
    }
  });
  await proxy.start();

  const client = net.connect(proxy.server.address().port, '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'connect');
  const responseChunks = [];
  client.on('data', chunk => responseChunks.push(Buffer.from(chunk)));
  client.write(
    `GET http://127.0.0.1:${origin.address().port}/socket HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${origin.address().port}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    (extension ? `Sec-WebSocket-Extensions: ${extension}\r\n` : '') +
    '\r\n'
  );

  await waitFor(
    () => Buffer.concat(responseChunks).includes(Buffer.from('\r\n\r\n')) && upgradedSocket,
    'Timed out waiting for WebSocket upgrade'
  );
  t.after(async () => {
    client.destroy();
    for (const socket of originSockets) socket.destroy();
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
  });
  return { client, events, originSocket: upgradedSocket, proxy };
}

test('WebSocket decompression queue overload omits bounded frames then recovers',
  { timeout: 15000 }, async t => {
    let releaseFirstCapture;
    const firstCaptureGate = new Promise(resolve => { releaseFirstCapture = resolve; });
    let captureStarted;
    const firstCaptureStarted = new Promise(resolve => { captureStarted = resolve; });
    const pair = await createWebSocketPair(t, {
      extension: 'permessage-deflate; server_no_context_takeover'
    });
    const emitWsFrame = pair.proxy._emitWsFrame.bind(pair.proxy);
    let gated = false;
    pair.proxy._emitWsFrame = async (...args) => {
      if (!gated) {
        gated = true;
        captureStarted();
        await firstCaptureGate;
      }
      return emitWsFrame(...args);
    };

    const queuedFrames = Array.from({ length: 66 }, (_, index) => encodeFrame(
      compressMessage(`queued-${index}`),
      { compressed: true }
    ));
    pair.originSocket.write(Buffer.concat(queuedFrames));
    await firstCaptureStarted;
    releaseFirstCapture();
    await waitFor(
      () => pair.events.filter(event => event.protocol === 'ws-frame').length === 64,
      'Timed out draining bounded WebSocket capture queue'
    );

    pair.originSocket.write(encodeFrame(compressMessage('recovered'), { compressed: true }));
    await waitFor(
      () => pair.events.some(event => event.protocol === 'ws-frame'
        && String(event.requestBody) === 'recovered'),
      'Timed out waiting for capture recovery'
    );
    pair.originSocket.end();
    const parent = await waitFor(
      () => pair.events.findLast(event => event.protocol === 'ws'
        && event.webSocketCaptureTruncated === true),
      'Timed out waiting for truncated WebSocket parent capture'
    );

    const frames = pair.events.filter(event => event.protocol === 'ws-frame');
    assert.equal(frames.length, 65);
    assert.equal(frames.at(-1).requestBody, 'recovered');
    assert.equal(frames.at(-1).sequence, 67);
    assert.equal(parent.responseBodyTruncated, true);
    assert.equal(parent.webSocketCaptureOmissions.server.messages, 2);
    assert.equal(parent.webSocketCaptureOmissions.server.messageCountExact, true);
    assert.equal(parent.webSocketCaptureOmissions.server.byteCountExact, true);
    assert.ok(parent.webSocketCaptureOmissions.server.bytes > 0);
    assert.deepEqual(
      parent.webSocketCaptureOmissions.server.reasons,
      ['ERR_WS_CAPTURE_QUEUE_OVERLOAD']
    );
  });

test('unrecoverable WebSocket parser omissions are disclosed on the parent capture',
  { timeout: 10000 }, async t => {
    const pair = await createWebSocketPair(t);
    const oversizedHeader = Buffer.alloc(10);
    oversizedHeader[0] = 0x82;
    oversizedHeader[1] = 127 | 0x80;
    oversizedHeader.writeBigUInt64BE(BigInt(DEFAULT_MAX_WS_FRAME_PAYLOAD + 1), 2);
    const laterFrame = encodeFrame('not capturable after parser failure', { masked: true });

    pair.client.write(oversizedHeader);
    pair.client.write(laterFrame);
    pair.client.end();
    const parent = await waitFor(
      () => pair.events.findLast(event => event.protocol === 'ws'
        && event.webSocketCaptureTruncated === true),
      'Timed out waiting for parser omission disclosure'
    );

    assert.equal(pair.events.some(event => event.protocol === 'ws-frame'), false);
    assert.equal(parent.requestBodyTruncated, true);
    assert.equal(parent.webSocketCaptureOmissions.client.messages, 1);
    assert.equal(parent.webSocketCaptureOmissions.client.messageCountExact, false);
    assert.equal(parent.webSocketCaptureOmissions.client.byteCountExact, false);
    assert.equal(
      parent.webSocketCaptureOmissions.client.bytes,
      oversizedHeader.length + laterFrame.length
    );
    assert.deepEqual(
      parent.webSocketCaptureOmissions.client.reasons,
      ['ERR_WS_FRAME_TOO_LARGE']
    );
  });

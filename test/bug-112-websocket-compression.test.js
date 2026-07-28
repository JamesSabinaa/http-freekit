import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import zlib from 'node:zlib';

import { ProxyServer } from '../src/proxy/proxy-server.js';
import { WS_OPCODE, WsFrameParser } from '../src/proxy/ws-frame-parser.js';
import {
  createPerMessageDeflateDecoder,
  parsePerMessageDeflate
} from '../src/proxy/ws-permessage-deflate.js';

const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

function encodeFrame({
  fin = true,
  rsv1 = false,
  rsv2 = false,
  rsv3 = false,
  opcode,
  payload = Buffer.alloc(0),
  masked = false,
  maskKey = Buffer.from([0x11, 0x22, 0x33, 0x44])
}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const firstByte = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) |
    (rsv2 ? 0x20 : 0) | (rsv3 ? 0x10 : 0) | opcode;
  let lengthBytes;
  if (body.length <= 125) {
    lengthBytes = Buffer.from([(masked ? 0x80 : 0) | body.length]);
  } else if (body.length <= 0xffff) {
    lengthBytes = Buffer.allocUnsafe(3);
    lengthBytes[0] = (masked ? 0x80 : 0) | 126;
    lengthBytes.writeUInt16BE(body.length, 1);
  } else {
    lengthBytes = Buffer.allocUnsafe(9);
    lengthBytes[0] = (masked ? 0x80 : 0) | 127;
    lengthBytes.writeBigUInt64BE(BigInt(body.length), 1);
  }
  if (!masked) return Buffer.concat([Buffer.from([firstByte]), lengthBytes, body]);

  const maskedBody = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index++) {
    maskedBody[index] = body[index] ^ maskKey[index & 3];
  }
  return Buffer.concat([Buffer.from([firstByte]), lengthBytes, maskKey, maskedBody]);
}

async function compressWithContext(messages) {
  const deflater = zlib.createDeflateRaw();
  const chunks = [];
  deflater.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const compressed = [];
  for (const message of messages) {
    deflater.write(Buffer.from(message));
    await new Promise((resolve, reject) => {
      deflater.flush(zlib.constants.Z_SYNC_FLUSH, error => error ? reject(error) : resolve());
    });
    const block = Buffer.concat(chunks.splice(0));
    assert.deepEqual(block.subarray(-DEFLATE_TAIL.length), DEFLATE_TAIL);
    compressed.push(block.subarray(0, -DEFLATE_TAIL.length));
  }
  deflater.close();
  return compressed;
}

function compressWithoutContext(message) {
  const block = zlib.deflateRawSync(Buffer.from(message), {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH
  });
  assert.deepEqual(block.subarray(-DEFLATE_TAIL.length), DEFLATE_TAIL);
  return block.subarray(0, -DEFLATE_TAIL.length);
}

function deterministicText() {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(4096);
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes.toString('base64');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function responsePayload(bytes) {
  const separator = Buffer.from('\r\n\r\n');
  const headerEnd = bytes.indexOf(separator);
  assert.ok(headerEnd >= 0);
  return bytes.subarray(headerEnd + separator.length);
}

test('parser preserves compression state across fragments and rejects invalid RSV use', () => {
  const emitted = [];
  const parser = new WsFrameParser(frame => emitted.push(frame));
  parser.push(encodeFrame({
    fin: false,
    rsv1: true,
    opcode: WS_OPCODE.TEXT,
    payload: 'first'
  }));
  parser.push(encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'second' }));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].compressed, true);
  assert.equal(emitted[0].rsv1, true);
  assert.equal(emitted[0].fragmented, true);
  assert.equal(emitted[0].payload.toString(), 'firstsecond');

  for (const frame of [
    encodeFrame({ rsv2: true, opcode: WS_OPCODE.TEXT, payload: 'invalid' }),
    encodeFrame({ rsv1: true, opcode: WS_OPCODE.PING, payload: 'invalid' }),
    Buffer.concat([
      encodeFrame({ fin: false, rsv1: true, opcode: WS_OPCODE.TEXT, payload: 'open' }),
      encodeFrame({ rsv1: true, opcode: WS_OPCODE.CONTINUATION, payload: 'invalid' })
    ])
  ]) {
    const invalidParser = new WsFrameParser(() => {});
    assert.throws(() => invalidParser.push(frame), error =>
      error.code === 'ERR_WS_UNSUPPORTED_RSV' ||
      error.code === 'ERR_WS_INVALID_CONTROL_FRAME' ||
      error.code === 'ERR_WS_INVALID_FRAGMENTATION'
    );
    assert.equal(invalidParser._disabled, true);
  }
});

test('permessage-deflate negotiation is direction-specific and rejects ambiguity', () => {
  assert.deepEqual(parsePerMessageDeflate({
    'Sec-WebSocket-Extensions': [
      'other-extension; note="comma,inside"',
      'PerMessage-Deflate; client_no_context_takeover; server_max_window_bits="12"'
    ]
  }), {
    client: { noContextTakeover: true, windowBits: 15 },
    server: { noContextTakeover: false, windowBits: 12 }
  });
  assert.equal(parsePerMessageDeflate({
    'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits=7'
  }), null);
  assert.equal(parsePerMessageDeflate({
    'sec-websocket-extensions': 'permessage-deflate; server_no_context_takeover; server_no_context_takeover'
  }), null);
  assert.equal(parsePerMessageDeflate({
    'sec-websocket-extensions': 'permessage-deflate; unknown=value'
  }), null);
});

test('permessage-deflate decoding is asynchronous, output-bounded, and recoverable without takeover', async () => {
  const decoder = createPerMessageDeflateDecoder(
    { noContextTakeover: true, windowBits: 15 },
    16
  );
  const oversized = decoder.decode(compressWithoutContext('A'.repeat(1024)));
  assert.ok(oversized instanceof Promise);
  await assert.rejects(oversized, error =>
    error.code === 'ERR_BUFFER_TOO_LARGE' ||
    error.code === 'ERR_WS_DECOMPRESSED_MESSAGE_TOO_LARGE'
  );
  assert.equal(
    (await decoder.decode(compressWithoutContext('recovered'))).toString(),
    'recovered'
  );

  const takeoverDecoder = createPerMessageDeflateDecoder(
    { noContextTakeover: false, windowBits: 15 },
    16
  );
  await assert.rejects(takeoverDecoder.decode(Buffer.from('invalid deflate')));
  await assert.rejects(
    () => takeoverDecoder.decode(compressWithoutContext('valid')),
    /context is unavailable/
  );
});

test('context takeover copies only its bounded sliding window', async () => {
  const decodedSize = 4 * 1024 * 1024;
  const decoder = createPerMessageDeflateDecoder(
    { noContextTakeover: false, windowBits: 15 },
    decodedSize
  );
  const decoded = await decoder.decode(compressWithoutContext('A'.repeat(decodedSize)));
  assert.equal(decoded.length, decodedSize);
  assert.deepEqual(decoder.retainedHistoryAllocation(), {
    length: 32 * 1024,
    byteLength: 32 * 1024
  });
});

test('proxy decodes negotiated compressed messages in both directions with context takeover', async t => {
  const shared = deterministicText();
  const clientMessages = [`${shared} client-one`, `${shared} client-two`];
  const serverMessages = [`${shared} server-one`, `${shared} server-two`];
  const [clientFirst, clientSecond] = await compressWithContext(clientMessages);
  const [serverFirst, serverSecond] = await compressWithContext(serverMessages);

  assert.throws(() => zlib.inflateRawSync(
    Buffer.concat([clientSecond, DEFLATE_TAIL]),
    { finishFlush: zlib.constants.Z_SYNC_FLUSH }
  ));

  const splitAt = Math.floor(clientFirst.length / 2);
  const clientWire = Buffer.concat([
    encodeFrame({
      fin: false,
      rsv1: true,
      opcode: WS_OPCODE.TEXT,
      payload: clientFirst.subarray(0, splitAt),
      masked: true
    }),
    encodeFrame({
      opcode: WS_OPCODE.CONTINUATION,
      payload: clientFirst.subarray(splitAt),
      masked: true
    }),
    encodeFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: clientSecond, masked: true })
  ]);
  const serverWire = Buffer.concat([
    encodeFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: serverFirst }),
    encodeFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: serverSecond })
  ]);

  const originSockets = new Set();
  const originPayloadChunks = [];
  const origin = net.createServer(originSocket => {
    originSockets.add(originSocket);
    originSocket.on('close', () => originSockets.delete(originSocket));
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    originSocket.on('data', chunk => {
      if (upgraded) {
        originPayloadChunks.push(Buffer.from(chunk));
        return;
      }
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd < 0) return;
      upgraded = true;
      const extra = handshake.subarray(headerEnd + 4);
      if (extra.length > 0) originPayloadChunks.push(extra);
      assert.match(handshake.subarray(0, headerEnd).toString('latin1'), /Sec-WebSocket-Extensions: permessage-deflate/i);
      originSocket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n'
      );
      originSocket.write(serverWire);
    });
  });
  const originPort = await listen(origin);

  const events = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => events.push(event) });
  await proxy.start();
  const clientChunks = [];
  const client = net.connect(proxy.server.address().port, '127.0.0.1');
  client.on('data', chunk => clientChunks.push(Buffer.from(chunk)));
  client.on('error', () => {});
  await once(client, 'connect');
  client.write(
    `GET http://127.0.0.1:${originPort}/socket HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n'
  );

  t.after(async () => {
    client.destroy();
    for (const originSocket of originSockets) originSocket.destroy();
    await proxy.stop();
    await close(origin);
  });

  await waitFor(
    () => Buffer.concat(clientChunks).includes(Buffer.from('\r\n\r\n')),
    'Timed out waiting for compressed WebSocket handshake'
  );
  client.write(clientWire);
  await waitFor(
    () => events.filter(event => event.protocol === 'ws-frame').length === 4,
    'Timed out waiting for compressed WebSocket captures'
  );
  await waitFor(
    () => Buffer.concat(originPayloadChunks).length >= clientWire.length,
    'Timed out waiting for compressed client relay bytes'
  );
  await waitFor(
    () => responsePayload(Buffer.concat(clientChunks)).length >= serverWire.length,
    'Timed out waiting for compressed server relay bytes'
  );

  assert.deepEqual(Buffer.concat(originPayloadChunks), clientWire);
  assert.deepEqual(responsePayload(Buffer.concat(clientChunks)), serverWire);
  const frames = events.filter(event => event.protocol === 'ws-frame');
  assert.deepEqual(frames.map(frame => frame.sequence), [1, 2, 3, 4]);
  assert.deepEqual(
    frames.filter(frame => frame.direction === 'client').map(frame => frame.requestBody),
    clientMessages
  );
  assert.deepEqual(
    frames.filter(frame => frame.direction === 'server').map(frame => frame.requestBody),
    serverMessages
  );
  assert.ok(frames.every(frame => frame.compressed === true && frame.rsv1 === true));
  assert.ok(frames.every(frame => frame.decompressionError === undefined));
  assert.deepEqual(
    frames.filter(frame => frame.direction === 'client').map(frame => frame.requestBodySize),
    [clientFirst.length, clientSecond.length]
  );
  assert.deepEqual(
    frames.filter(frame => frame.direction === 'client').map(frame => frame.requestBodyDecodedSize),
    clientMessages.map(message => Buffer.byteLength(message))
  );
});

test('proxy stop waits for queued WebSocket captures and their final connection update', async t => {
  const compressed = compressWithoutContext('captured before shutdown');
  const compressedFrame = encodeFrame({
    rsv1: true,
    opcode: WS_OPCODE.TEXT,
    payload: compressed
  });
  const originSockets = new Set();
  const origin = net.createServer(originSocket => {
    originSockets.add(originSocket);
    originSocket.on('close', () => originSockets.delete(originSocket));
    let handshake = Buffer.alloc(0);
    originSocket.on('data', chunk => {
      handshake = Buffer.concat([handshake, chunk]);
      if (!handshake.includes(Buffer.from('\r\n\r\n'))) return;
      originSocket.removeAllListeners('data');
      originSocket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover\r\n\r\n'
      );
      originSocket.write(compressedFrame);
    });
  });
  const originPort = await listen(origin);

  let releaseCapture;
  const captureGate = new Promise(resolve => { releaseCapture = resolve; });
  let reportCaptureStarted;
  const captureStarted = new Promise(resolve => { reportCaptureStarted = resolve; });
  const events = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => events.push(event) });
  const emitWsFrame = proxy._emitWsFrame.bind(proxy);
  proxy._emitWsFrame = async (...args) => {
    reportCaptureStarted();
    await captureGate;
    return emitWsFrame(...args);
  };
  await proxy.start();

  const client = net.connect(proxy.server.address().port, '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'connect');
  client.write(
    `GET http://127.0.0.1:${originPort}/socket HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n'
  );

  t.after(async () => {
    releaseCapture();
    client.destroy();
    for (const originSocket of originSockets) originSocket.destroy();
    await proxy.stop();
    await close(origin);
  });

  await captureStarted;
  let stopResolved = false;
  const stopping = proxy.stop().then(() => { stopResolved = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stopResolved, false);

  releaseCapture();
  await stopping;
  const frame = events.find(event => event.protocol === 'ws-frame');
  assert.equal(frame?.requestBody, 'captured before shutdown');
  const connection = events.findLast(event => event.protocol === 'ws');
  assert.equal(connection?.responseBody, `1 messages (${compressedFrame.length} bytes)`);
  const eventCountAtStop = events.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(events.length, eventCountAtStop);
});

test('compressed frames without a negotiated extension show a safe capture marker', () => {
  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  proxy._emitWsFrame({
    fin: true,
    rsv1: true,
    rsv2: false,
    rsv3: false,
    compressed: true,
    opcode: WS_OPCODE.TEXT,
    masked: false,
    payload: Buffer.from([0xff, 0xfe]),
    timestamp: 1
  }, 'server', 'parent', 1);

  assert.match(events[0].requestBody, /^\[Unable to decompress WebSocket message:/);
  assert.equal(events[0].requestBody.includes('\ufffd'), false);
  assert.match(events[0].decompressionError, /not negotiated/);
});

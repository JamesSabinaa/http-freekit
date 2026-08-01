import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';
import { WS_OPCODE, WsFrameParser } from '../../../src/proxy/ws-frame-parser.js';

function encodeFrame({ fin = true, opcode, payload = Buffer.alloc(0), masked = false, maskKey }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  assert.ok(body.length <= 125, 'test frame helper only supports short payloads');
  const header = Buffer.from([
    (fin ? 0x80 : 0) | opcode,
    (masked ? 0x80 : 0) | body.length
  ]);
  if (!masked) return Buffer.concat([header, body]);

  const mask = maskKey || Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const maskedBody = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i++) maskedBody[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, maskedBody]);
}

function pushBytewise(parser, wire) {
  for (const byte of wire) parser.push(Buffer.from([byte]));
}

test('parser assembles masked trickled text fragments with the initial metadata', t => {
  const emitted = [];
  const timestamps = [100, 200];
  t.mock.method(Date, 'now', () => timestamps.shift());
  const parser = new WsFrameParser(frame => emitted.push(frame));
  const wire = Buffer.concat([
    encodeFrame({ fin: false, opcode: WS_OPCODE.TEXT, payload: 'hel', masked: true }),
    encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'lo', masked: true })
  ]);

  pushBytewise(parser, wire);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].opcode, WS_OPCODE.TEXT);
  assert.equal(emitted[0].timestamp, 100);
  assert.equal(emitted[0].masked, true);
  assert.equal(emitted[0].fin, true);
  assert.equal(emitted[0].fragmented, true);
  assert.equal(emitted[0].fragmentCount, 2);
  assert.equal(emitted[0].payload.toString(), 'hello');
});

test('parser preserves interleaved controls while assembling a binary message', t => {
  const emitted = [];
  const timestamps = [100, 200, 300, 400, 500];
  t.mock.method(Date, 'now', () => timestamps.shift());
  const parser = new WsFrameParser(frame => emitted.push(frame));
  const closePayload = Buffer.alloc(2);
  closePayload.writeUInt16BE(1000);

  parser.push(Buffer.concat([
    encodeFrame({ fin: false, opcode: WS_OPCODE.BINARY, payload: Buffer.from([0, 1]) }),
    encodeFrame({ opcode: WS_OPCODE.PING, payload: '?' }),
    encodeFrame({ opcode: WS_OPCODE.PONG, payload: '!' }),
    encodeFrame({ opcode: WS_OPCODE.CLOSE, payload: closePayload }),
    encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: Buffer.from([2, 3]) })
  ]));

  assert.deepEqual(emitted.map(frame => frame.opcode), [
    WS_OPCODE.PING,
    WS_OPCODE.PONG,
    WS_OPCODE.CLOSE,
    WS_OPCODE.BINARY
  ]);
  assert.deepEqual(emitted.map(frame => frame.timestamp), [200, 300, 400, 100]);
  assert.deepEqual(emitted.at(-1).payload, Buffer.from([0, 1, 2, 3]));
  assert.equal(emitted.at(-1).fragmentCount, 2);
});

test('parser drops cumulative fragmented payloads beyond the capture bound', () => {
  const emitted = [];
  const parser = new WsFrameParser(frame => emitted.push(frame), {
    maxPayloadLength: 8,
    maxMessagePayloadLength: 5
  });
  parser.push(encodeFrame({ fin: false, opcode: WS_OPCODE.TEXT, payload: 'hel' }));

  assert.throws(
    () => parser.push(encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'lo!' })),
    error => error.code === 'ERR_WS_MESSAGE_TOO_LARGE'
  );
  assert.deepEqual(emitted, []);
  assert.equal(parser._disabled, true);
  assert.equal(parser._fragment, null);

  parser.push(encodeFrame({ opcode: WS_OPCODE.TEXT, payload: 'ignored' }));
  assert.deepEqual(emitted, []);
});

test('parser bounds fragment count even when continuations have empty payloads', () => {
  const parser = new WsFrameParser(() => {}, { maxMessageFragments: 2 });
  parser.push(encodeFrame({ fin: false, opcode: WS_OPCODE.TEXT, payload: '' }));
  parser.push(encodeFrame({ fin: false, opcode: WS_OPCODE.CONTINUATION, payload: '' }));

  assert.throws(
    () => parser.push(encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: '' })),
    error => error.code === 'ERR_WS_TOO_MANY_FRAGMENTS'
  );
  assert.equal(parser._disabled, true);
  assert.equal(parser._fragment, null);
});

test('parser disables capture for malformed continuation sequences and controls', () => {
  const malformedSequences = [
    [encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'orphan' })],
    [
      encodeFrame({ fin: false, opcode: WS_OPCODE.TEXT, payload: 'open' }),
      encodeFrame({ opcode: WS_OPCODE.BINARY, payload: 'replacement' })
    ],
    [encodeFrame({ fin: false, opcode: WS_OPCODE.PING, payload: '?' })]
  ];

  for (const frames of malformedSequences) {
    const emitted = [];
    const parser = new WsFrameParser(frame => emitted.push(frame));
    assert.throws(() => frames.forEach(frame => parser.push(frame)), error =>
      error.code === 'ERR_WS_INVALID_FRAGMENTATION' || error.code === 'ERR_WS_INVALID_CONTROL_FRAME'
    );
    assert.deepEqual(emitted, []);
    assert.equal(parser._disabled, true);
    parser.push(encodeFrame({ opcode: WS_OPCODE.TEXT, payload: 'ignored' }));
    assert.deepEqual(emitted, []);
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function captureTraffic() {
  const events = [];
  return {
    events,
    onRequest(data) {
      events.push({
        ...data,
        requestHeaders: { ...data.requestHeaders },
        responseHeaders: { ...data.responseHeaders }
      });
    }
  };
}

async function createRawWebSocket(t, { serverWire = Buffer.alloc(0), proxyOptions = {} } = {}) {
  const originChunks = [];
  const originSockets = new Set();
  const origin = http.createServer();
  origin.on('upgrade', (_req, socket, head) => {
    originSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => originSockets.delete(socket));
    if (head.length) originChunks.push(Buffer.from(head));
    socket.on('data', chunk => originChunks.push(Buffer.from(chunk)));
    socket.on('end', () => socket.end());
    socket.write(Buffer.concat([
      Buffer.from(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n\r\n',
        'latin1'
      ),
      serverWire
    ]));
  });
  const originPort = await listen(origin);
  const capture = captureTraffic();
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: data => capture.onRequest(data),
    ...proxyOptions
  });
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
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );

  t.after(async () => {
    client.destroy();
    for (const socket of originSockets) socket.destroy();
    await proxy.stop();
    await close(origin);
  });

  const clientBytes = () => Buffer.concat(clientChunks);
  await waitFor(
    () => clientBytes().includes(Buffer.from('\r\n\r\n')),
    'Timed out waiting for the proxied WebSocket handshake'
  );

  return { capture, client, clientBytes, originChunks };
}

function responsePayload(bytes) {
  const separator = Buffer.from('\r\n\r\n');
  const headerEnd = bytes.indexOf(separator);
  assert.ok(headerEnd >= 0);
  return bytes.subarray(headerEnd + separator.length);
}

test('real proxy captures one logical record per fragmented message and relays every byte', async t => {
  const serverWire = Buffer.concat([
    encodeFrame({ fin: false, opcode: WS_OPCODE.BINARY, payload: Buffer.from([0, 1]) }),
    encodeFrame({ opcode: WS_OPCODE.PONG, payload: '!' }),
    encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: Buffer.from([2, 3]) })
  ]);
  const clientWire = Buffer.concat([
    encodeFrame({ fin: false, opcode: WS_OPCODE.TEXT, payload: 'hel', masked: true }),
    encodeFrame({ opcode: WS_OPCODE.PING, payload: '?', masked: true }),
    encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'lo', masked: true })
  ]);
  const session = await createRawWebSocket(t, { serverWire });

  for (const byte of clientWire) session.client.write(Buffer.from([byte]));
  await waitFor(
    () => Buffer.concat(session.originChunks).length >= clientWire.length,
    'Timed out waiting for fragmented client bytes at the origin'
  );
  await waitFor(
    () => session.capture.events.filter(event => event.protocol === 'ws-frame').length === 4,
    'Timed out waiting for logical WebSocket captures'
  );

  assert.deepEqual(Buffer.concat(session.originChunks), clientWire);
  await waitFor(
    () => responsePayload(session.clientBytes()).length >= serverWire.length,
    'Timed out waiting for fragmented server bytes at the client'
  );
  assert.deepEqual(responsePayload(session.clientBytes()), serverWire);

  const frames = session.capture.events.filter(event => event.protocol === 'ws-frame');
  assert.deepEqual(frames.map(frame => frame.sequence), [1, 2, 3, 4]);
  const serverFrames = frames.filter(frame => frame.direction === 'server');
  const clientFrames = frames.filter(frame => frame.direction === 'client');
  assert.deepEqual(serverFrames.map(frame => frame.opcode), [WS_OPCODE.PONG, WS_OPCODE.BINARY]);
  assert.deepEqual(clientFrames.map(frame => frame.opcode), [WS_OPCODE.PING, WS_OPCODE.TEXT]);
  assert.equal(serverFrames[0].requestBody, '!');
  assert.equal(serverFrames[1].requestBody, '00010203');
  assert.equal(serverFrames[1].fragmented, true);
  assert.equal(serverFrames[1].fragmentCount, 2);
  assert.equal(clientFrames[0].requestBody, '?');
  assert.equal(clientFrames[1].requestBody, 'hello');
  assert.equal(clientFrames[1].requestBodySize, 5);
  assert.equal(clientFrames[1].masked, true);
  assert.equal(clientFrames[1].fragmented, true);

  const parentId = session.capture.events.find(
    event => event.protocol === 'ws' && event._update && event.statusCode === 101
  ).id;
  assert.ok(frames.every(frame => frame.parentId === parentId));

  session.client.end();
  await waitFor(
    () => session.capture.events.filter(
      event => event.protocol === 'ws' && event._update && event.statusCode === 101
    ).length === 2,
    'Timed out waiting for the final WebSocket summary'
  );
  const finalParent = session.capture.events.filter(event => event.protocol === 'ws').at(-1);
  assert.equal(finalParent.requestBody, 'WebSocket: 1 sent, 1 received');
  assert.equal(finalParent.responseBody, `2 messages (${clientWire.length + serverWire.length} bytes)`);
});

test('real proxy drops unsafe fragmented capture while continuing transparent relay', async t => {
  const scenarios = [
    {
      name: 'oversized cumulative message',
      proxyOptions: { maxWsCapturedMessageBytes: 5 },
      wire: Buffer.concat([
        encodeFrame({ fin: false, opcode: WS_OPCODE.TEXT, payload: 'hel', masked: true }),
        encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'lo!', masked: true }),
        encodeFrame({ opcode: WS_OPCODE.TEXT, payload: 'after', masked: true })
      ])
    },
    {
      name: 'orphan continuation',
      proxyOptions: {},
      wire: Buffer.concat([
        encodeFrame({ opcode: WS_OPCODE.CONTINUATION, payload: 'orphan', masked: true }),
        encodeFrame({ opcode: WS_OPCODE.TEXT, payload: 'after', masked: true })
      ])
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async subtest => {
      const session = await createRawWebSocket(subtest, { proxyOptions: scenario.proxyOptions });
      session.client.write(scenario.wire);
      await waitFor(
        () => Buffer.concat(session.originChunks).length >= scenario.wire.length,
        `Timed out waiting for ${scenario.name} relay bytes`
      );
      assert.deepEqual(Buffer.concat(session.originChunks), scenario.wire);

      session.client.end();
      await waitFor(
        () => session.capture.events.filter(
          event => event.protocol === 'ws' && event._update && event.statusCode === 101
        ).length === 2,
        `Timed out waiting for ${scenario.name} final summary`
      );
      assert.equal(
        session.capture.events.filter(event => event.protocol === 'ws-frame').length,
        0
      );
      const finalParent = session.capture.events.filter(event => event.protocol === 'ws').at(-1);
      assert.equal(finalParent.requestBody, 'WebSocket: 0 sent, 0 received');
    });
  }
});

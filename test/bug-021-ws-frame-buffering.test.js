import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAX_WS_FRAME_PAYLOAD,
  WS_OPCODE,
  WsFrameParser
} from '../src/proxy/ws-frame-parser.js';

test('WebSocket parser rejects oversized advertised frames before buffering payloads', () => {
  const parser = new WsFrameParser(() => {});
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(DEFAULT_MAX_WS_FRAME_PAYLOAD + 1), 2);

  assert.throws(() => parser.push(header), (err) => {
    assert.equal(err.code, 'ERR_WS_FRAME_TOO_LARGE');
    return true;
  });
  assert.equal(parser._bufferedLength, 0);
  assert.deepEqual(parser._chunks, []);

  parser.push(Buffer.alloc(1024));
  assert.equal(parser._bufferedLength, 0);
});

test('WebSocket parser handles trickled frames without concatenating retained data', () => {
  const frames = [];
  const parser = new WsFrameParser(frame => frames.push(frame));
  const payload = Buffer.alloc(60 * 1024, 0x61);
  const header = Buffer.alloc(4);
  header[0] = 0x82;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);

  const originalConcat = Buffer.concat;
  let concatCalls = 0;
  Buffer.concat = (...args) => {
    concatCalls++;
    return originalConcat(...args);
  };
  try {
    for (const byte of header) parser.push(Buffer.from([byte]));
    for (let offset = 0; offset < payload.length; offset += 31) {
      parser.push(payload.subarray(offset, offset + 31));
    }
  } finally {
    Buffer.concat = originalConcat;
  }

  assert.equal(concatCalls, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE.BINARY);
  assert.deepEqual(frames[0].payload, payload);
  assert.equal(parser._bufferedLength, 0);
});

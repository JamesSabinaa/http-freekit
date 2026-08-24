import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import * as pako from 'pako';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function headerValue(');
const end = source.indexOf('function beautifyMarkup(', start);
assert.ok(start >= 0 && end > start);
const grpcSource = source.slice(start, end);

function grpcDataUri(messageBytes, encoding = 'gzip') {
  const compressed = encoding === 'gzip'
    ? pako.gzip(messageBytes)
    : pako.deflate(messageBytes);
  const frame = new Uint8Array(5 + compressed.length);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(1, compressed.length);
  frame.set(compressed, 5);
  return 'data:application/grpc;base64,' + Buffer.from(frame).toString('base64');
}

function createHarness() {
  let schemaDecodeCalls = 0;
  const streamingPako = {
    Inflate: pako.Inflate,
    ungzip() { throw new Error('one-shot ungzip must not run'); },
    inflate() { throw new Error('one-shot inflate must not run'); }
  };
  const context = {
    window: { pako: streamingPako },
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    BigInt,
    atob,
    isConnectContentType: () => false,
    inferGrpcMessageType: () => null,
    inferProtobufMessageType: () => null,
    lookupProtobufType: () => null,
    decodeWithProtobufType() {
      schemaDecodeCalls++;
      return 'schema output';
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${grpcSource}
    globalThis.grpcApi = {
      decode: decodeGrpcBody,
      decompress: decompressGrpcMessage
    };
  `, context);
  return {
    decode(body, encoding = 'gzip') {
      return context.grpcApi.decode(body, {
        section: 'response',
        contentType: 'application/grpc',
        request: {
          responseBodyEncoding: 'base64',
          responseHeaders: { 'grpc-encoding': encoding }
        }
      });
    },
    get schemaDecodeCalls() { return schemaDecodeCalls; }
  };
}

test('gRPC preview incrementally decompresses ordinary messages without one-shot pako APIs', () => {
  const harness = createHarness();
  const output = harness.decode(grpcDataUri(Uint8Array.from([0x08, 0x96, 0x01])));

  assert.match(output, /decompressed-size=3/);
  assert.match(output, /1: varint 150/);
  assert.doesNotMatch(output, /decompression-truncated/);
});

test('high-ratio gRPC messages stop at bounded output and render explicit limit metadata', () => {
  const harness = createHarness();
  const output = harness.decode(grpcDataUri(new Uint8Array(2 * 1024 * 1024)));

  assert.match(output, /decompression-truncated=true/);
  assert.match(output, /expanded-size>=\d+ limit=\d+/);
  assert.match(output, /absolute-max=4194304, ratio-max=100:1 after 65536-byte grace/);
  assert.match(output, /compressed hex:/);
  assert.doesNotMatch(output, /decompressed-size=/);
  assert.equal(harness.schemaDecodeCalls, 0);
  assert.ok(output.length < 2000, 'limit diagnostics must remain bounded');
});

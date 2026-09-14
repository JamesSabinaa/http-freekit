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
    ${source.slice(source.indexOf('function isGrpcContentType('), source.indexOf('const activeBodyEditors = {}'))}
    ${grpcSource}
    globalThis.grpcApi = {
      decode: decodeGrpcBody,
      decompress: decompressGrpcMessage
    };
  `, context);
  return {
    decode(body, encoding = 'gzip', contentType = 'application/grpc') {
      return context.grpcApi.decode(body, {
        section: 'response',
        contentType,
        request: {
          responseBodyEncoding: 'base64',
          responseHeaders: { 'grpc-encoding': encoding, 'connect-content-encoding': encoding }
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

function connectEndStream(bytes, compressed = true) {
  const header = Buffer.alloc(5);
  header[0] = compressed ? 3 : 2;
  header.writeUInt32BE(bytes.length, 1);
  return 'data:application/connect+proto;base64,' + Buffer.concat([header, bytes]).toString('base64');
}

test('Connect EndStream previews decompress JSON errors and trailing metadata', () => {
  const payload = Buffer.from(JSON.stringify({ error: { code: 'unavailable', message: 'Try later' }, metadata: { 'retry-after': ['30'] } }));
  for (const encoding of ['gzip', 'deflate', 'identity']) {
    const bytes = encoding === 'gzip' ? pako.gzip(payload) : encoding === 'deflate' ? pako.deflate(payload) : payload;
    const output = createHarness().decode(connectEndStream(bytes, encoding !== 'identity'), encoding, 'application/connect+proto');
    assert.match(output, /end stream:/);
    assert.match(output, /Try later/);
    assert.match(output, /retry-after/);
    assert.doesNotMatch(output, /unable to|hex:/);
  }
});

test('Connect EndStream decompression retains bounded and malformed-payload diagnostics', () => {
  const harness = createHarness();
  const oversized = harness.decode(connectEndStream(pako.gzip(Buffer.alloc(2 * 1024 * 1024, 32))), 'gzip', 'application/connect+proto');
  assert.match(oversized, /end stream:/);
  assert.match(oversized, /decompression-truncated=true/);
  assert.ok(oversized.length < 2000);
  const invalid = harness.decode(connectEndStream(Buffer.from('invalid gzip')), 'gzip', 'application/connect+proto');
  assert.match(invalid, /unable to decompress/);
  assert.equal(harness.schemaDecodeCalls, 0);
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

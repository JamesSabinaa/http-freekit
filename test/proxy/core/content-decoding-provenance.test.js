import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function captureStreamedBody(bytes, contentEncoding, contentType = 'text/plain') {
  const proxy = new ProxyServer(null);
  const collector = proxy._createBodyCollector();
  proxy._appendBodyChunk(collector, bytes);
  const captured = {
    requestBody: proxy._streamedCaptureBody(collector, bytes.length, 'Request', {
      'content-encoding': contentEncoding,
      'content-type': contentType
    })
  };
  proxy._normalizeCapturedBodies(captured);
  return captured;
}

test('streamed capture marks each successfully decoded Content-Encoding representation', async t => {
  const text = 'semantic replay text ✓';
  const utf8 = Buffer.from(text);
  const gzip = zlib.gzipSync(utf8);
  const deflate = zlib.deflateSync(utf8);
  const brotli = zlib.brotliCompressSync(utf8);
  const stacked = zlib.brotliCompressSync(gzip);

  for (const [name, encoding, bytes] of [
    ['gzip', 'gzip', gzip],
    ['x-gzip', 'X-GZip', gzip],
    ['deflate', 'deflate', deflate],
    ['brotli', 'br', brotli],
    ['stacked gzip and brotli', 'gzip, br', stacked]
  ]) {
    await t.test(name, () => {
      const captured = captureStreamedBody(bytes, encoding);
      assert.equal(captured.requestBody, text);
      assert.equal(captured.requestBodyEncoding, 'utf8');
      assert.equal(captured.requestBodyContentDecoded, true);
    });
  }
});

test('successful decoding retains provenance for empty and non-UTF-8 decoded bodies', () => {
  const empty = captureStreamedBody(zlib.gzipSync(Buffer.alloc(0)), 'gzip');
  assert.equal(empty.requestBody, '');
  assert.equal(empty.requestBodyEncoding, 'utf8');
  assert.equal(empty.requestBodyContentDecoded, true);

  const bytes = Buffer.from([0x00, 0xff, 0x41]);
  const binary = captureStreamedBody(
    zlib.gzipSync(bytes),
    'gzip',
    'application/octet-stream'
  );
  assert.equal(binary.requestBodyEncoding, 'base64');
  assert.equal(binary.requestBodyContentDecoded, true);
  assert.equal(
    binary.requestBody,
    `data:application/octet-stream;base64,${bytes.toString('base64')}`
  );
});

test('malformed, unknown, identity, and absent codings never claim content decoding', async t => {
  const rawText = Buffer.from('not a gzip stream');
  const compressed = zlib.gzipSync(Buffer.from('still compressed'));
  const cases = [
    ['malformed gzip', rawText, 'gzip', rawText.toString(), 'utf8'],
    [
      'unknown coding',
      compressed,
      'made-up-coding',
      `data:text/plain;base64,${compressed.toString('base64')}`,
      'base64'
    ],
    ['identity', rawText, 'identity', rawText.toString(), 'utf8'],
    ['absent', rawText, undefined, rawText.toString(), 'utf8']
  ];

  for (const [name, bytes, encoding, expectedBody, expectedEncoding] of cases) {
    await t.test(name, () => {
      const captured = captureStreamedBody(bytes, encoding);
      assert.equal(captured.requestBody, expectedBody);
      assert.equal(captured.requestBodyEncoding, expectedEncoding);
      assert.equal(Object.hasOwn(captured, 'requestBodyContentDecoded'), false);
    });
  }
});

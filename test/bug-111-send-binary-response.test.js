import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('Send preserves non-UTF8 response bytes with explicit base64 metadata', async t => {
  const expected = Buffer.from([0x00, 0xff, 0x80, 0x01]);
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/octet-stream; version=1',
      'content-length': String(expected.length)
    });
    response.end(expected);
  });
  const originPort = await listen(origin);
  t.after(() => close(origin));

  const result = await ApiServer.prototype._sendRequest.call(
    {}, `http://127.0.0.1:${originPort}/binary`, 'GET', {}, ''
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.bodyEncoding, 'base64');
  assert.equal(result.bodySize, expected.length);
  assert.equal(result.body, `data:application/octet-stream;base64,${expected.toString('base64')}`);
  const encoded = result.body.slice(result.body.indexOf(',') + 1);
  assert.deepEqual(Buffer.from(encoded, 'base64'), expected);
});

test('Send keeps reversible UTF-8 response text and its byte size', async t => {
  const expected = 'snowman: ☃';
  const origin = http.createServer((_request, response) => response.end(expected));
  const originPort = await listen(origin);
  t.after(() => close(origin));

  const result = await ApiServer.prototype._sendRequest.call(
    {}, `http://127.0.0.1:${originPort}/text`, 'GET', {}, ''
  );

  assert.equal(result.body, expected);
  assert.equal(result.bodyEncoding, 'utf8');
  assert.equal(result.bodySize, Buffer.byteLength(expected));
});

test('Send normalizes valid media types and rejects unsafe data URI media types', async t => {
  const expected = Buffer.from([0xff]);
  const origin = http.createServer((request, response) => {
    response.writeHead(200, {
      'content-type': request.url === '/valid'
        ? 'Image/PNG; version=1'
        : 'image/png" onerror="alert(1)',
      'content-length': String(expected.length)
    });
    response.end(expected);
  });
  const originPort = await listen(origin);
  t.after(() => close(origin));

  const valid = await ApiServer.prototype._sendRequest.call(
    {}, `http://127.0.0.1:${originPort}/valid`, 'GET', {}, ''
  );
  const unsafe = await ApiServer.prototype._sendRequest.call(
    {}, `http://127.0.0.1:${originPort}/unsafe`, 'GET', {}, ''
  );

  assert.equal(valid.body, 'data:image/png;base64,/w==');
  assert.equal(unsafe.body, 'data:application/octet-stream;base64,/w==');
});

test('body byte views decode data URIs only with base64 provenance', async () => {
  const source = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function bodyToBytes(');
  const end = source.indexOf('\n    function readProtoVarint(', start);
  assert.ok(start >= 0 && end > start);
  const bodyToBytes = Function(`${source.slice(start, end)}; return bodyToBytes;`)();
  const body = 'data:application/octet-stream;base64,/w==';

  assert.deepEqual(
    [...bodyToBytes(body, { section: 'response', request: { responseBodyEncoding: 'base64' } })],
    [0xff]
  );
  assert.deepEqual(
    [...bodyToBytes(body, { section: 'response', request: { responseBodyEncoding: 'utf8' } })],
    [...new TextEncoder().encode(body)]
  );
});

test('image previews accept only constrained base64 data URIs and escape the source', async () => {
  const source = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const escapeStart = source.indexOf('function escapeHtmlAttribute(');
  const start = source.indexOf('function getSafeImageDataUri(');
  const end = source.indexOf('\n    function formatBodyAs(', start);
  assert.ok(escapeStart >= 0 && start > escapeStart && end > start);
  const escapeHtmlAttribute = Function(
    `${source.slice(escapeStart, start)}; return escapeHtmlAttribute;`
  )();
  const getSafeImageDataUri = Function(`${source.slice(start, end)}; return getSafeImageDataUri;`)();

  assert.equal(escapeHtmlAttribute('x" onerror="alert(1)<'), 'x&quot; onerror=&quot;alert(1)&lt;');
  assert.equal(getSafeImageDataUri('data:Image/PNG;base64,iVBORw=='), 'data:image/png;base64,iVBORw==');
  assert.equal(getSafeImageDataUri('data:image/png" onerror="alert(1);base64,iVBORw=='), '');
  assert.match(source, /'<img src="' \+ escapeHtmlAttribute\(safeImageDataUri\)/);
});

test('Send traffic entries retain response encoding and wire size metadata', async () => {
  const source = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(source, /responseBodyEncoding:\s*data\.bodyEncoding \|\| 'utf8'/);
  assert.match(source, /responseBodySize:\s*Number\.isFinite\(data\.bodySize\)/);
  assert.match(source, /responseBodyEncoding:\s*tab\.response\.bodyEncoding \|\| 'utf8'/);
});

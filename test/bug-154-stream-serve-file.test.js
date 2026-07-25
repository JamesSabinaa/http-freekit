import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function requestThroughProxy(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: target }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('serve-file streams its response and records small file content', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-serve-file-'));
  const filePath = path.join(tempDir, 'response.txt');
  await fs.writeFile(filePath, 'streamed mock response');
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const captured = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: request => captured.push(request) });
  proxy.addMockRule({
    matchers: [{ type: 'wildcard' }],
    action: { type: 'serve-file', filePath, contentType: 'text/plain', status: 202 }
  });
  await proxy.start();
  t.after(() => proxy.stop());

  const response = await requestThroughProxy(
    proxy.server.address().port,
    'http://unreachable.invalid/file'
  );

  assert.equal(response.statusCode, 202);
  assert.equal(response.headers['content-type'], 'text/plain');
  assert.equal(response.body.toString(), 'streamed mock response');
  const record = captured.find(request => request.statusMessage === 'Mocked (file)');
  assert.equal(record.responseBody, 'streamed mock response');
  assert.equal(record.responseBodySize, response.body.length);
  assert.equal(record.responseBodyTruncated, false);
});

test('large serve-file captures stay bounded while the file is streamed', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-large-file-'));
  const filePath = path.join(tempDir, 'large.bin');
  const content = Buffer.alloc(256 * 1024, 0x61);
  await fs.writeFile(filePath, content);
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const proxy = new ProxyServer(null, { maxBufferedBodyBytes: 1024 });
  let receivedBytes = 0;
  const destination = new Writable({
    highWaterMark: 1024,
    write(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      setImmediate(callback);
    }
  });

  const result = await proxy._streamMockFile(filePath, destination);

  assert.equal(receivedBytes, content.length);
  assert.equal(result.size, content.length);
  assert.equal(result.content, null);
  assert.equal(result.truncated, true);
});

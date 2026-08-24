import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { ProxyServer } from '../../src/proxy/proxy-server.js';

function requestThroughProxy(port, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: target, method }, response => {
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

function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
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
  const record = await waitFor(() => captured.find(request => request.statusMessage === 'Mocked (file)'));
  assert.equal(record.responseBody, 'streamed mock response');
  assert.equal(record.responseBodySize, response.body.length);
  assert.equal(record.responseBodyTruncated, false);
});

test('serve-file suppresses forbidden response bodies and capture bytes', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-bodyless-file-'));
  const filePath = path.join(tempDir, 'response.txt');
  await fs.writeFile(filePath, 'must not be delivered');
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const captured = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: request => captured.push(request) });
  for (const [pathname, status] of [['/head-file', 200], ['/no-content-file', 204]]) {
    proxy.addMockRule({
      matchers: [{ type: 'path', matchType: 'exact', value: pathname }],
      action: { type: 'serve-file', filePath, contentType: 'text/plain', status }
    });
  }
  await proxy.start();
  t.after(() => proxy.stop());

  for (const [pathname, method, status] of [
    ['/head-file', 'HEAD', 200],
    ['/no-content-file', 'GET', 204]
  ]) {
    const response = await requestThroughProxy(
      proxy.server.address().port,
      `http://unreachable.invalid${pathname}`,
      method
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.body.length, 0);
    const record = await waitFor(() => captured.find(request =>
      request.path === pathname && request.statusMessage === 'Mocked (file)'
    ));
    assert.equal(record.responseBody, '');
    assert.equal(record.responseBodySize, 0);
  }
});

test('serve-file capture preserves the configured media type for binary content', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-typed-file-'));
  const filePath = path.join(tempDir, 'pixel.png');
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await fs.writeFile(filePath, content);
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const captured = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: request => captured.push(request) });
  proxy.addMockRule({
    matchers: [{ type: 'wildcard' }],
    action: { type: 'serve-file', filePath, contentType: 'image/png' }
  });
  await proxy.start();
  t.after(() => proxy.stop());

  const response = await requestThroughProxy(
    proxy.server.address().port,
    'http://unreachable.invalid/pixel.png'
  );
  const record = await waitFor(() => captured.find(
    request => request.statusMessage === 'Mocked (file)'
  ));

  assert.equal(response.headers['content-type'], 'image/png');
  assert.deepEqual(response.body, content);
  assert.equal(
    record.responseBody,
    `data:image/png;base64,${content.toString('base64')}`
  );
  assert.equal(record.responseBodyEncoding, 'base64');
  assert.equal(record.responseBodySize, content.length);
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

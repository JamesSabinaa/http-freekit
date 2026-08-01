import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import zlib from 'node:zlib';
import { ApiServer } from '../../../src/api/api-server.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('body collectors discard buffered chunks as soon as their limit is exceeded', () => {
  const proxy = new ProxyServer(null, { maxBufferedBodyBytes: 8 });
  const collector = proxy._createBodyCollector();

  assert.equal(proxy._appendBodyChunk(collector, Buffer.from('12345')), true);
  assert.equal(proxy._appendBodyChunk(collector, Buffer.from('6789')), false);
  assert.equal(collector.exceeded, true);
  assert.equal(collector.chunks.length, 0);
  assert.equal(proxy._concatBody(collector).length, 0);
});

test('decompression refuses output beyond the configured ceiling', () => {
  const proxy = new ProxyServer(null, { maxDecompressedBodyBytes: 1024 });
  const compressed = zlib.gzipSync(Buffer.alloc(64 * 1024, 65));

  assert.deepEqual(proxy._decompressBody(compressed, 'gzip'), compressed);
});

test('oversized pass-through uploads stream while capture remains bounded', async (t) => {
  let originHits = 0;
  let receivedBody = '';
  const origin = http.createServer((req, res) => {
    originHits++;
    req.setEncoding('utf8');
    req.on('data', chunk => { receivedBody += chunk; });
    req.on('end', () => res.end('forwarded'));
  });
  const originPort = await listen(origin);
  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    maxBufferedBodyBytes: 8,
    onRequest: event => events.push(event)
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const statusCode = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/upload`,
      method: 'POST',
      headers: { 'content-length': '9' }
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end('123456789');
  });

  assert.equal(statusCode, 200);
  assert.equal(originHits, 1);
  assert.equal(receivedBody, '123456789');
  const finalRecord = events.find(event => event._update);
  assert.equal(finalRecord.requestBodyTruncated, true);
  assert.equal(finalRecord.requestBodyCapturedSize, 0);
  assert.equal(finalRecord.requestBodySize, 9);
});

test('Send rejects an upstream response beyond its buffer ceiling', async (t) => {
  const origin = http.createServer((req, res) => res.end('123456789'));
  const originPort = await listen(origin);
  t.after(() => close(origin));
  const api = new ApiServer(new ProxyServer(null, { port: 0 }), null, null, { sendMaxResponseBytes: 8 });

  await assert.rejects(
    api._sendRequest(`http://127.0.0.1:${originPort}/`, 'GET', {}, ''),
    /exceeds 8 byte buffer limit/
  );
});

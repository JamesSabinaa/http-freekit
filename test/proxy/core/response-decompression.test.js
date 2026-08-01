import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import zlib from 'node:zlib';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl
    }, response => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
  });
}

async function captureEncodedResponse(t, contentEncoding, encodedBody) {
  const origin = http.createServer((request, response) => {
    response.writeHead(200, {
      'Content-Encoding': contentEncoding,
      'Content-Type': 'text/plain',
      'Content-Length': encodedBody.length
    });
    response.end(encodedBody);
  });
  const originPort = await listen(origin);

  let resolveCapture;
  const captured = new Promise(resolve => { resolveCapture = resolve; });
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: request => {
      if (request._update && request.statusCode === 200) resolveCapture(request);
    }
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  await requestThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/encoded`
  );
  return captured;
}

test('response capture decodes mixed-case Content-Encoding tokens', async t => {
  const text = 'mixed-case gzip response';
  const captured = await captureEncodedResponse(t, 'GZip', zlib.gzipSync(text));

  assert.equal(captured.responseBody, text);
});

test('response capture decodes stacked Content-Encoding values in reverse order', async t => {
  const text = 'stacked gzip then brotli response';
  const gzipBody = zlib.gzipSync(text);
  const stackedBody = zlib.brotliCompressSync(gzipBody);
  const captured = await captureEncodedResponse(t, 'gzip, br', stackedBody);

  assert.equal(captured.responseBody, text);
});

test('stacked decompression returns the original bytes when a stage exceeds the ceiling', () => {
  const proxy = new ProxyServer(null, { maxDecompressedBodyBytes: 1024 });
  const gzipBody = zlib.gzipSync(Buffer.alloc(64 * 1024, 65));
  const stackedBody = zlib.brotliCompressSync(gzipBody);

  assert.deepEqual(proxy._decompressBody(stackedBody, 'gzip, br'), stackedBody);
});

test('stacked decompression returns the original bytes when a stage is invalid', () => {
  const proxy = new ProxyServer(null);
  const invalidStack = zlib.brotliCompressSync(Buffer.from('not a gzip stream'));

  assert.deepEqual(proxy._decompressBody(invalidStack, 'gzip, br'), invalidStack);
});

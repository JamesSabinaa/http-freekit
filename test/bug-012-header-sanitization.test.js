import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('client proxy credentials and forwarding identity headers never reach the origin', async (t) => {
  let receivedHeaders;
  const origin = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.end('ok');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/headers`,
      headers: {
        host: `127.0.0.1:${originPort}`,
        'proxy-authorization': 'Basic c2VjcmV0',
        'proxy-connection': 'keep-alive',
        'x-forwarded-for': '203.0.113.10',
        forwarded: 'for=203.0.113.10',
        'x-test-header': 'preserved'
      }
    }, (res) => {
      res.resume();
      res.once('end', resolve);
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(receivedHeaders['proxy-authorization'], undefined);
  assert.equal(receivedHeaders['proxy-connection'], undefined);
  assert.equal(receivedHeaders['x-forwarded-for'], undefined);
  assert.equal(receivedHeaders.forwarded, undefined);
  assert.equal(receivedHeaders['x-test-header'], 'preserved');
});

test('H1 forwarding rebuilds hop-by-hop headers for each connection', async t => {
  let receivedHeaders;
  const origin = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, {
      Connection: 'X-Response-Remove, Keep-Alive',
      'X-Response-Remove': 'response secret',
      'Keep-Alive': 'timeout=30',
      Upgrade: 'example-protocol',
      'Proxy-Authenticate': 'Basic realm="origin"',
      'X-Response-Keep': 'preserved'
    });
    res.end('ok');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const responseHeaders = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/hop-by-hop`,
      headers: {
        host: `127.0.0.1:${originPort}`,
        connection: 'X-Request-Remove, Keep-Alive',
        'x-request-remove': 'request secret',
        'keep-alive': 'timeout=30',
        te: 'trailers',
        upgrade: 'example-protocol',
        'x-request-keep': 'preserved'
      }
    }, res => {
      res.resume();
      res.once('end', () => resolve(res.headers));
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(receivedHeaders['x-request-remove'], undefined);
  assert.equal(receivedHeaders['keep-alive'], undefined);
  assert.equal(receivedHeaders.te, undefined);
  assert.equal(receivedHeaders.upgrade, undefined);
  assert.equal(receivedHeaders['x-request-keep'], 'preserved');
  assert.equal(responseHeaders['x-response-remove'], undefined);
  assert.notEqual(responseHeaders['keep-alive'], 'timeout=30');
  assert.equal(responseHeaders.upgrade, undefined);
  assert.equal(responseHeaders['proxy-authenticate'], undefined);
  assert.equal(responseHeaders['x-response-keep'], 'preserved');
});

test('H1 to H2 conversion strips Connection-nominated request fields', async () => {
  const proxy = new ProxyServer(null);
  let receivedHeaders;
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.closed = false;
  stream.close = () => { stream.closed = true; };
  stream.end = () => queueMicrotask(() => {
    stream.emit('response', { ':status': 200 });
    stream.emit('end');
  });
  const session = {
    request(headers) {
      receivedHeaders = headers;
      return stream;
    },
    socket: {}
  };

  const response = await proxy._makeH2Request(
    session,
    'GET',
    'origin.example.test',
    443,
    '/',
    {
      connection: ['X-Remove', 'Keep-Alive'],
      'x-remove': 'secret',
      'keep-alive': 'timeout=30',
      te: 'trailers',
      trailer: 'X-Trailer',
      'x-keep': 'preserved'
    },
    Buffer.alloc(0)
  );

  assert.equal(response.statusCode, 200);
  assert.equal(receivedHeaders.connection, undefined);
  assert.equal(receivedHeaders['x-remove'], undefined);
  assert.equal(receivedHeaders['keep-alive'], undefined);
  assert.equal(receivedHeaders.te, undefined);
  assert.equal(receivedHeaders.trailer, undefined);
  assert.equal(receivedHeaders['x-keep'], 'preserved');
});

test('407 responses retain the downstream proxy authentication challenge', async t => {
  const origin = http.createServer((_request, response) => {
    response.writeHead(407, {
      'proxy-authenticate': 'Basic realm="upstream"',
      'content-length': '0'
    });
    response.end();
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const response = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/auth`
    }, result => {
      result.resume();
      result.once('end', () => resolve(result));
    });
    request.once('error', reject);
  });

  assert.equal(response.statusCode, 407);
  assert.equal(response.headers['proxy-authenticate'], 'Basic realm="upstream"');
  assert.equal(
    proxy._toH2ResponseHeaders(407, { 'proxy-authenticate': 'Basic realm="upstream"' })
      ['proxy-authenticate'],
    'Basic realm="upstream"'
  );
});

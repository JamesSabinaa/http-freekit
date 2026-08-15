import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
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

test('H1 forward actions send headers produced by pre-steps', async (t) => {
  let receivedHeaders;
  const origin = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.end('forwarded');
  });
  const originPort = await listen(origin);

  const proxy = new ProxyServer(null, { port: 0 });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    preSteps: [
      { type: 'add-header', name: 'X-Added-By-Step', value: 'yes' },
      { type: 'remove-header', name: 'X-Remove-Me' }
    ],
    action: { type: 'forward', forwardTo: `http://127.0.0.1:${originPort}` }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const responseBody = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: 'http://original.invalid/resource',
      headers: {
        host: 'original.invalid',
        'X-Original-Case': 'preserved',
        'X-Remove-Me': 'old'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(responseBody, 'forwarded');
  assert.equal(receivedHeaders['x-added-by-step'], 'yes');
  assert.equal(receivedHeaders['x-original-case'], 'preserved');
  assert.equal(receivedHeaders['x-remove-me'], undefined);
  assert.equal(receivedHeaders.host, `127.0.0.1:${originPort}`);
});

test('raw-case header reconstruction respects changed and deleted current headers', () => {
  const proxy = new ProxyServer(null);
  const headers = proxy._currentHeadersWithRawCase(
    ['X-Original-Case', 'old', 'X-Deleted', 'gone'],
    { 'x-original-case': 'new', 'x-added': 'yes' }
  );

  assert.equal(Object.getPrototypeOf(headers), null);
  assert.deepEqual({ ...headers }, { 'X-Original-Case': 'new', 'x-added': 'yes' });
});

test('header-copy helpers retain own prototype-named fields and strip nominated fields', () => {
  const proxy = new ProxyServer(null);
  const source = JSON.parse(
    '{"__proto__":"prototype-value","constructor":"constructor-value",' +
    '"toString":"string-value","connection":"__proto__, X-Remove",' +
    '"X-Remove":"removed","X-Keep":["one","two"]}'
  );

  const stripped = proxy._stripHopByHopHeaders(source);
  assert.equal(Object.getPrototypeOf(stripped), null);
  assert.equal(Object.hasOwn(stripped, '__proto__'), false);
  assert.equal(stripped.constructor, 'constructor-value');
  assert.equal(stripped.toString, 'string-value');
  assert.deepEqual(stripped['X-Keep'], ['one', 'two']);

  const upstream = proxy._stripUpstreamHeaders(JSON.parse(
    '{"__proto__":"kept","constructor":"ctor","toString":"text","x-forwarded-for":"removed"}'
  ));
  assert.equal(Object.getPrototypeOf(upstream), null);
  assert.equal(upstream.__proto__, 'kept');
  assert.equal(upstream.constructor, 'ctor');
  assert.equal(upstream.toString, 'text');
  assert.equal(Object.hasOwn(upstream, 'x-forwarded-for'), false);

  const current = JSON.parse(
    '{"__proto__":"new-proto","constructor":"new-ctor","toString":"new-text"}'
  );
  const recased = proxy._currentHeadersWithRawCase([
    '__proto__', 'old-proto',
    'Constructor', 'old-ctor',
    'ToString', 'old-text',
    'X-Deleted', 'gone'
  ], current);
  assert.equal(Object.getPrototypeOf(recased), null);
  assert.equal(recased.__proto__, 'new-proto');
  assert.equal(recased.Constructor, 'new-ctor');
  assert.equal(recased.ToString, 'new-text');
  assert.equal(Object.hasOwn(recased, 'X-Deleted'), false);

  const trailers = proxy._cleanTrailers(
    { constructor: 'parsed-ctor' },
    [
      '__proto__', 'raw-proto',
      '__PROTO__', 'raw-proto-two',
      'constructor', 'raw-ctor',
      'toString', 'raw-text'
    ]
  );
  assert.equal(Object.getPrototypeOf(trailers), null);
  assert.deepEqual(trailers.__proto__, ['raw-proto', 'raw-proto-two']);
  assert.equal(trailers.constructor, 'parsed-ctor');
  assert.equal(trailers.tostring, 'raw-text');

  const h2Headers = proxy._toH2ResponseHeaders(200, JSON.parse(
    '{"__proto__":"h2-proto","constructor":"h2-ctor","toString":"h2-text"}'
  ));
  assert.equal(Object.getPrototypeOf(h2Headers), Object.prototype);
  assert.equal(Object.hasOwn(h2Headers, '__proto__'), true);
  assert.equal(h2Headers.__proto__, 'h2-proto');
  assert.equal(h2Headers.constructor, 'h2-ctor');
  assert.equal(h2Headers.tostring, 'h2-text');
});

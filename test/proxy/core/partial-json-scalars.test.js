import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function requestThroughProxy(port, target, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: target,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('scalar and empty partial JSON expectations require an exact JSON value', () => {
  const proxy = new ProxyServer(null);
  const cases = [
    ['1', '1', '2'],
    ['true', 'true', 'false'],
    ['false', 'false', 'true'],
    ['"value"', '"value"', '"other"'],
    ['null', 'null', '0'],
    ['[]', '[]', '[1]'],
    ['{}', '{}', '{"extra":true}']
  ];

  for (const [expected, exactBody, differentBody] of cases) {
    const matcher = { type: 'json-body-includes', value: expected };
    assert.equal(proxy._evaluateMatcher(matcher, 'POST', 'http://example.test/', {}, exactBody), true, expected);
    assert.equal(proxy._evaluateMatcher(matcher, 'POST', 'http://example.test/', {}, differentBody), false, expected);
  }
});

test('non-empty partial JSON expectations retain top-level subset matching', () => {
  const proxy = new ProxyServer(null);

  assert.equal(proxy._evaluateMatcher(
    { type: 'json-body-includes', value: '{"match":true}' },
    'POST', 'http://example.test/', {}, '{"match":true,"extra":"value"}'
  ), true);
  assert.equal(proxy._evaluateMatcher(
    { type: 'json-body-includes', value: '{"match":true}' },
    'POST', 'http://example.test/', {}, '{"match":false,"extra":"value"}'
  ), false);
  assert.equal(proxy._evaluateMatcher(
    { type: 'json-body-includes', value: '[1]' },
    'POST', 'http://example.test/', {}, '[1,2]'
  ), true);
});

test('a scalar partial JSON rule no longer intercepts a different JSON body', async t => {
  let originHits = 0;
  const origin = http.createServer((request, response) => {
    originHits++;
    request.resume();
    response.end('origin response');
  });
  origin.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    origin.once('listening', resolve);
    origin.once('error', reject);
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));

  const proxy = new ProxyServer(null, { port: 0 });
  proxy.addMockRule({
    matchers: [{ type: 'json-body-includes', value: '1' }],
    action: { type: 'fixed-response', status: 219, body: 'scalar matcher fired' }
  });
  await proxy.start();
  t.after(() => proxy.stop());

  const target = `http://127.0.0.1:${origin.address().port}/value`;
  assert.deepEqual(
    await requestThroughProxy(proxy.server.address().port, target, '2'),
    { statusCode: 200, body: 'origin response' }
  );
  assert.equal(originHits, 1);

  assert.deepEqual(
    await requestThroughProxy(proxy.server.address().port, target, '1'),
    { statusCode: 219, body: 'scalar matcher fired' }
  );
  assert.equal(originHits, 1);
});

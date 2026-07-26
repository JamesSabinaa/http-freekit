import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

const PROTOTYPE_COOKIE_NAMES = ['constructor', 'toString', '__proto__'];

function evaluateCookie(proxy, name, value, cookieHeader) {
  const headers = cookieHeader === undefined ? {} : { cookie: cookieHeader };
  return proxy._evaluateMatcher(
    { type: 'cookie', name, value },
    'GET',
    'http://example.test/cookies',
    headers,
    ''
  );
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestThroughProxy(proxyPort, originPort, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: `http://127.0.0.1:${originPort}/cookies`,
      method: 'GET',
      ...(cookie === undefined ? {} : { headers: { cookie } })
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('cookie matchers only find parsed cookie names and retain exact values', () => {
  const proxy = new ProxyServer(null);

  for (const name of PROTOTYPE_COOKIE_NAMES) {
    assert.equal(evaluateCookie(proxy, name, '', undefined), false, `${name} without a Cookie header`);
    assert.equal(evaluateCookie(proxy, name, '', 'ordinary=value'), false, `${name} absent`);
    assert.equal(evaluateCookie(proxy, name, '', `${name}=present`), true, `${name} present`);
    assert.equal(evaluateCookie(proxy, name, 'present', `${name}=present`), true, `${name} exact value`);
    assert.equal(evaluateCookie(proxy, name, 'other', `${name}=present`), false, `${name} wrong value`);
  }

  assert.equal(evaluateCookie(proxy, 'ordinary', '', undefined), false);
  assert.equal(evaluateCookie(proxy, 'ordinary', '', 'ordinary=value'), true);
  assert.equal(evaluateCookie(proxy, 'ordinary', 'value', 'ordinary=value'), true);
  assert.equal(evaluateCookie(proxy, 'ordinary', 'other', 'ordinary=value'), false);
  assert.equal(evaluateCookie(proxy, 'token', 'abc=def==', 'token=abc=def=='), true);
});

test('live proxy cookie rules ignore absent prototype names and match real cookies', async t => {
  const origin = http.createServer((_request, response) => {
    response.end('origin');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const proxyPort = proxy.server.address().port;
  for (const name of PROTOTYPE_COOKIE_NAMES) {
    proxy.mockRules = [{
      enabled: true,
      matchers: [{ type: 'cookie', name, value: '' }],
      action: { type: 'fixed-response', status: 209, body: `matched ${name}` }
    }];

    assert.deepEqual(
      await requestThroughProxy(proxyPort, originPort),
      { statusCode: 200, body: 'origin' },
      `${name} without a Cookie header`
    );
    assert.deepEqual(
      await requestThroughProxy(proxyPort, originPort, 'ordinary=value'),
      { statusCode: 200, body: 'origin' },
      `${name} absent from a normal Cookie header`
    );
    assert.deepEqual(
      await requestThroughProxy(proxyPort, originPort, `${name}=present`),
      { statusCode: 209, body: `matched ${name}` },
      `${name} present`
    );
  }

  proxy.mockRules = [{
    enabled: true,
    matchers: [{ type: 'cookie', name: 'token', value: 'abc=def==' }],
    action: { type: 'fixed-response', status: 210, body: 'matched token' }
  }];
  assert.deepEqual(
    await requestThroughProxy(proxyPort, originPort, 'token=abc=def=='),
    { statusCode: 210, body: 'matched token' }
  );
  assert.deepEqual(
    await requestThroughProxy(proxyPort, originPort, 'token=abc=other'),
    { statusCode: 200, body: 'origin' }
  );
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function basic(username, password = '') {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

test('Send applies decoded URL credentials without leaking userinfo to origin routing', async t => {
  const received = [];
  const origin = http.createServer((request, response) => {
    received.push({
      authorization: request.headers.authorization,
      host: request.headers.host,
      url: request.url
    });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  const originPort = await listen(origin);
  t.after(() => close(origin));

  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const apiHttpServer = http.createServer(api.app);
  const apiPort = await listen(apiHttpServer);
  t.after(() => close(apiHttpServer));

  const unicodeUsername = 'føø user@corp';
  const specialPassword = 'päss:@/?#%+';
  const cases = [
    {
      name: 'username only',
      url: `http://alice@127.0.0.1:${originPort}/username-only?visible=1`,
      headers: {},
      expectedAuthorization: basic('alice'),
      expectedPath: '/username-only?visible=1'
    },
    {
      name: 'explicit empty password',
      url: `http://bob:@127.0.0.1:${originPort}/empty-password`,
      headers: {},
      expectedAuthorization: basic('bob', ''),
      expectedPath: '/empty-password'
    },
    {
      name: 'percent-encoded Unicode and special characters',
      url: `http://${encodeURIComponent(unicodeUsername)}:${encodeURIComponent(specialPassword)}` +
        `@127.0.0.1:${originPort}/encoded?query=safe`,
      headers: {},
      expectedAuthorization: basic(unicodeUsername, specialPassword),
      expectedPath: '/encoded?query=safe'
    },
    {
      name: 'explicit Authorization wins',
      url: `http://ignored:credentials@127.0.0.1:${originPort}/explicit`,
      headers: { aUtHoRiZaTiOn: 'Bearer explicit-token' },
      expectedAuthorization: 'Bearer explicit-token',
      expectedPath: '/explicit'
    }
  ];

  for (const testCase of cases) {
    const response = await postJson(apiPort, '/api/send', {
      url: testCase.url,
      method: 'GET',
      headers: testCase.headers
    });
    assert.equal(response.statusCode, 200, testCase.name);
  }

  assert.equal(received.length, cases.length);
  for (const [index, testCase] of cases.entries()) {
    const request = received[index];
    assert.equal(request.authorization, testCase.expectedAuthorization, testCase.name);
    assert.equal(request.host, `127.0.0.1:${originPort}`, testCase.name);
    assert.equal(request.url, testCase.expectedPath, testCase.name);
    assert.doesNotMatch(request.host + request.url, /alice|bob|ignored|credentials|f%C3%B8|p%C3%A4ss/i);
  }
});

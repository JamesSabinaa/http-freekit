import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { restoreSavedRuleSettings } from '../src/startup-rule-restoration.js';

function validRule(id = 'valid') {
  return {
    id,
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  };
}

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
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

async function createApi(t) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { proxy, port: server.address().port };
}

test('persisted mock rules discard malformed leaves at every group depth', () => {
  const proxy = new ProxyServer(null);
  const restored = proxy.loadMockRules([
    validRule('top-level'),
    { id: 'bad-array', enabled: true, matchers: {}, action: { type: 'fixed-response' } },
    { id: 'bad-field', enabled: true, matchers: [{ type: 'host', value: 42 }], action: { type: 'fixed-response' } },
    {
      id: 'group',
      type: 'group',
      enabled: true,
      items: [
        validRule('child'),
        { id: 'bad-child', enabled: true, matchers: [null], action: { type: 'fixed-response' } },
        { id: 'nested', type: 'group', items: [validRule('nested-child'), { enabled: true }] }
      ]
    }
  ]);

  assert.equal(restored.migrated, true);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['top-level', 'group']);
  assert.deepEqual(proxy.mockRules[1].items.map(rule => rule.id), ['child', 'nested-child']);
  assert.equal(proxy._findMockRule('GET', 'https://example.test/', {}, ''), proxy.mockRules[0]);
});

test('startup persists the sanitized mock-rule tree', () => {
  const proxy = new ProxyServer(null);
  const writes = [];
  const settings = {
    get(key) {
      if (key === 'mockRules') {
        return [validRule('kept'), { id: 'removed', enabled: true, matchers: {}, action: {} }];
      }
      return undefined;
    },
    set(key, value) {
      writes.push([key, structuredClone(value)]);
    }
  };

  restoreSavedRuleSettings(proxy, settings, { log() {}, warn() {} });

  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['kept']);
  assert.deepEqual(writes.map(([key]) => key), ['mockRules']);
  assert.deepEqual(writes[0][1], proxy.mockRules);
});

test('runtime matcher evaluation fails closed for malformed rules', () => {
  const proxy = new ProxyServer(null);
  proxy.mockRules = [
    null,
    { enabled: true, matchers: {}, action: { type: 'fixed-response' } },
    { enabled: true, matchers: [{ type: 'method', value: {} }], action: { type: 'fixed-response' } },
    { enabled: true, matchers: [{ type: 'method', value: 'GET' }], action: [] },
    { enabled: true, method: {}, urlPattern: '/', response: {} }
  ];

  assert.doesNotThrow(() => proxy._findMockRule('GET', 'https://example.test/', null, ''));
  assert.equal(proxy._findMockRule('GET', 'https://example.test/', null, ''), undefined);
  assert.equal(proxy._evaluateMatcher(null, 'GET', 'https://example.test/', {}, ''), false);
  assert.equal(proxy._evaluateMatcher({ type: 'host', value: 42 }, 'GET', 'https://example.test/', {}, ''), false);
});

test('mock APIs reject malformed group children and invalid updates atomically', async t => {
  const { proxy, port } = await createApi(t);
  const groupResult = await requestJson(port, 'POST', '/api/mock-rules/group', {
    title: 'Invalid group',
    items: [{ enabled: true, matchers: {}, action: { type: 'fixed-response' } }]
  });

  assert.equal(groupResult.statusCode, 400);
  assert.deepEqual(proxy.mockRules, []);

  const rule = proxy.addMockRule(validRule());
  const before = structuredClone(rule);
  const updateResult = await requestJson(port, 'PUT', `/api/mock-rules/${rule.id}`, {
    action: []
  });

  assert.equal(updateResult.statusCode, 400);
  assert.deepEqual(rule, before);
});

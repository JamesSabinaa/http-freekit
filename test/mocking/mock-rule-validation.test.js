import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import {
  isCompleteMockMatcher,
  validateMockRule
} from '../../src/proxy/mock-rule-validation.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { restoreSavedRuleSettings } from '../../src/startup-rule-restoration.js';
import { Settings } from '../../src/settings.js';

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
  return { proxy, api, port: server.address().port };
}

test('initial mock-rule saves preserve titles in responses, storage, and restored rules', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'freekit-mock-titles-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { api, proxy, port } = await createApi(t);
  api.settings = new Settings(dataDir);
  for (const legacy of [false, true]) {
    for (const title of ['Source rule', 'Source rule (copy)', 'Mock POST /café', '', undefined]) {
      const candidate = legacy
        ? { method: 'POST', urlPattern: '/title', response: { status: 200, body: 'ok' } }
        : validRule();
      if (title !== undefined) candidate.title = title;
      const created = await requestJson(port, 'POST', '/api/mock-rules', candidate);
      assert.equal(created.statusCode, 200);
      const { id } = created.body.rule;
      assert.equal(created.body.rule.title, title);
      assert.equal(proxy.mockRules.find(rule => rule.id === id).title, title);
      const restored = new ProxyServer(null);
      restored.loadMockRules(new Settings(dataDir).get('mockRules'));
      assert.equal(restored.mockRules.find(rule => rule.id === id).title, title);
    }
  }
});

test('persisted mock rules discard malformed leaves at every group depth', () => {
  const proxy = new ProxyServer(null);
  const restored = proxy.loadMockRules([
    validRule('top-level'),
    { id: 'bad-array', enabled: true, matchers: {}, action: { type: 'fixed-response' } },
    { id: 'bad-field', enabled: true, matchers: [{ type: 'host', value: 42 }], action: { type: 'fixed-response' } },
    { id: 'bad-regex', enabled: true, matchers: [{ type: 'regex-url', value: '[' }], action: { type: 'fixed-response' } },
    { id: 'bad-json', enabled: true, matchers: [{ type: 'json-body-exact', value: '{bad' }], action: { type: 'fixed-response' } },
    { id: 'bad-port', enabled: true, matchers: [{ type: 'port', value: '70000' }], action: { type: 'fixed-response' } },
    { id: 'bad-protocol', enabled: true, matchers: [{ type: 'protocol', value: 'ftp' }], action: { type: 'fixed-response' } },
    { id: 'bad-path-mode', enabled: true, matchers: [{ type: 'path', value: '/', matchType: 'near' }], action: { type: 'fixed-response' } },
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
    {
      enabled: true,
      matchers: [{ type: 'method', value: 'GET' }],
      preSteps: [{ type: 'add-header', name: {} }],
      action: { type: 'fixed-response' }
    },
    {
      enabled: true,
      matchers: [{ type: 'method', value: 'GET' }],
      action: { type: 'fixed-response', body: {} }
    },
    { enabled: true, method: {}, urlPattern: '/', response: {} }
  ];

  assert.doesNotThrow(() => proxy._findMockRule('GET', 'https://example.test/', null, ''));
  assert.equal(proxy._findMockRule('GET', 'https://example.test/', null, ''), undefined);
  assert.equal(proxy._evaluateMatcher(null, 'GET', 'https://example.test/', {}, ''), false);
  assert.equal(proxy._evaluateMatcher({ type: 'host', value: 42 }, 'GET', 'https://example.test/', {}, ''), false);
});

test('method validation preserves wildcard and extension tokens while rejecting markup', () => {
  const proxy = new ProxyServer(null);
  const validMethods = ['*', 'M-SEARCH', "!#$%&'*+-.^_`|~AZaz09"];
  const invalidMethods = [
    '',
    'GET POST',
    'GET" data-audit="present',
    'GET></span><img src=x onerror=alert(1)>'
  ];

  for (const method of validMethods) {
    const matcher = { type: 'method', value: method };
    assert.equal(isCompleteMockMatcher(matcher), true, method);
    assert.equal(validateMockRule({
      enabled: true,
      matchers: [matcher],
      action: { type: 'fixed-response' }
    }), null, method);
    assert.equal(proxy._evaluateMatcher(
      matcher,
      method === '*' ? 'GET' : method,
      'https://example.test/',
      {},
      ''
    ), true, method);
  }

  for (const method of invalidMethods) {
    const matcher = { type: 'method', value: method };
    assert.equal(isCompleteMockMatcher(matcher), false, method);
    assert.equal(typeof validateMockRule({
      enabled: true,
      matchers: [matcher],
      action: { type: 'fixed-response' }
    }), 'string', method);
    assert.equal(proxy._evaluateMatcher(
      matcher, 'GET', 'https://example.test/', {}, ''
    ), false, method);
  }

  assert.equal(validateMockRule({
    enabled: true,
    method: 'M-SEARCH',
    urlPattern: '/',
    response: {}
  }), null);
  assert.equal(validateMockRule({
    enabled: true,
    method: '*',
    urlPattern: '/',
    response: {}
  }), null);
  assert.match(validateMockRule({
    enabled: true,
    method: 'GET"><img src=x>',
    urlPattern: '/',
    response: {}
  }), /valid HTTP method/);
});

test('validator rejects malformed execution fields before rules reach runtime handlers', () => {
  const base = {
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }]
  };
  const malformedRules = [
    { ...base, action: { type: 'unknown-action' } },
    { ...base, preSteps: [{ type: 'unknown-step' }], action: { type: 'fixed-response' } },
    { ...base, preSteps: [{ type: 'add-header', name: {} }], action: { type: 'fixed-response' } },
    { ...base, action: { type: 'fixed-response', status: '200' } },
    { ...base, action: { type: 'fixed-response', headers: [] } },
    { ...base, action: { type: 'fixed-response', headers: { 'bad header': 'value' } } },
    { ...base, action: { type: 'fixed-response', headers: { 'x-test': 'value\r\ninjected' } } },
    { ...base, action: { type: 'fixed-response', body: {} } },
    { ...base, action: { type: 'forward', addResponseHeaders: 'invalid' } },
    { ...base, action: { type: 'forward', forwardTo: 'http://example.test', addRequestHeaders: 'invalid' } },
    {
      ...base,
      action: {
        type: 'forward',
        forwardTo: 'http://example.test',
        addRequestHeaders: { 'bad header': 'value' }
      }
    },
    { ...base, action: { type: 'transform-request', methodMode: 'GET\r\nX-Evil: yes' } },
    { ...base, action: { type: 'transform-request', headersMode: 'invalid' } },
    { ...base, action: { type: 'transform-request', urlMode: 'modify', urlReplace: '' } },
    { ...base, action: { type: 'transform-request', urlMode: 'modify', urlReplace: 'ftp://example.test/' } },
    { ...base, action: { type: 'transform-request', bodyMode: 'json-merge', body: '{bad json' } },
    { ...base, action: { type: 'transform-request', bodyMode: 'json-merge', body: '[]' } },
    { ...base, action: { type: 'transform-response', bodyMode: 'json-merge', body: 'null' } },
    { ...base, preSteps: [{ type: 'rewrite-url', value: 'http://[invalid' }], action: { type: 'fixed-response' } },
    { ...base, preSteps: [{ type: 'rewrite-url', value: 'ftp://example.test/' }], action: { type: 'fixed-response' } },
    { ...base, action: { type: 'transform-request', removeHeaders: [42] } },
    { ...base, action: { type: 'transform-request', resStatusOverride: '201' } },
    { ...base, action: { type: 'transform-request', resStatusMode: 'replace' } },
    { ...base, action: { type: 'transform-response', bodyMode: 'invalid' } },
    { ...base, matchers: [{ type: 'regex-path', value: '[' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'regex-url', value: '(unterminated' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'regex-body', value: '*bad' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'json-body-exact', value: '{bad' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'json-body-includes', value: '[1,' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'port', value: '0' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'port', value: '70000' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'protocol', value: 'ftp' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'path', value: '/', matchType: 'exactly' }], action: { type: 'fixed-response' } },
    { ...base, matchers: [{ type: 'path', value: '[', matchType: 'regex' }], action: { type: 'fixed-response' } },
    { ...base, action: { type: 'serve-file' } },
    { ...base, action: { type: 'forward', forwardTo: '' } },
    { ...base, action: { type: 'webhook' } },
    { enabled: true, urlPattern: '/', response: { body: {} } }
  ];

  for (const rule of malformedRules) {
    assert.equal(typeof validateMockRule(rule), 'string');
  }

  assert.equal(validateMockRule({
    ...base,
    preSteps: [{ type: 'rewrite-url', value: '/relative-target' }],
    action: {
      type: 'transform-request',
      urlMode: 'modify',
      urlReplace: 'https://example.test/target',
      bodyMode: 'json-merge',
      body: '{"added":true}'
    }
  }), null);

  for (const matcher of [
    { type: 'regex-path', value: '^/valid(?:/.*)?$' },
    { type: 'json-body-exact', value: 'null' },
    { type: 'json-body-includes', value: '{"valid":true}' },
    { type: 'port', value: '65535' },
    { type: 'protocol', value: 'HTTPS' },
    { type: 'path', value: '^/valid$', matchType: 'regex' }
  ]) {
    assert.equal(validateMockRule({
      ...base,
      matchers: [matcher],
      action: { type: 'fixed-response' }
    }), null, matcher.type);
  }
});

test('mock delays stay within the supported Node timer range', () => {
  const base = {
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }]
  };
  const rulesForDelay = delay => [
    {
      ...base,
      preSteps: [{ type: 'delay', ms: delay }],
      action: { type: 'fixed-response' }
    },
    { ...base, action: { type: 'fixed-response', delay } }
  ];

  for (const delay of [0, 2_147_483_647]) {
    for (const rule of rulesForDelay(delay)) {
      assert.equal(validateMockRule(rule), null, String(delay));
    }
  }

  for (const delay of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    for (const rule of rulesForDelay(delay)) {
      assert.match(validateMockRule(rule), /from 0 through 2147483647/, String(delay));
    }
  }
});

test('forward and webhook actions require usable credential-free HTTP destinations', () => {
  const ruleFor = action => ({
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action
  });

  for (const [type, property] of [
    ['forward', 'forwardTo'],
    ['webhook', 'webhookUrl']
  ]) {
    for (const destination of [
      'http://example.test/path?query=yes',
      'https://[::1]:8443/destination'
    ]) {
      assert.equal(validateMockRule(ruleFor({
        type,
        [property]: destination
      })), null, `${type}: ${destination}`);
    }

    for (const destination of [
      'not a URL',
      'ftp://example.test/path',
      'http://example.test:0/path',
      'http://user:secret@example.test/path'
    ]) {
      assert.match(validateMockRule(ruleFor({
        type,
        [property]: destination
      })), /HTTP or HTTPS URL|port from 1|credentials/, `${type}: ${destination}`);
    }
  }
});

test('mock APIs reject invalid destinations before mutating rules', async t => {
  const { proxy, port } = await createApi(t);

  for (const action of [
    { type: 'forward', forwardTo: 'ftp://example.test/path' },
    { type: 'forward', forwardTo: 'http://example.test:0/path' },
    { type: 'webhook', webhookUrl: 'http://user:secret@example.test/hook' }
  ]) {
    const result = await requestJson(port, 'POST', '/api/mock-rules', {
      matchers: [],
      action
    });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(proxy.mockRules, []);
  }
});

test('add-header pre-steps accept numeric zero as a valid header value', () => {
  const rule = validRule('numeric-zero-header');
  rule.preSteps = [{ type: 'add-header', name: 'x-zero', value: 0 }];

  assert.equal(validateMockRule(rule), null);
});

test('every mock final-response status accepts only integers from 200 through 599', () => {
  const base = {
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }]
  };
  const rulesForStatus = status => [
    { ...base, action: { type: 'fixed-response', status } },
    { ...base, action: { type: 'serve-file', filePath: '/tmp/response.txt', status } },
    {
      ...base,
      action: {
        type: 'transform-request',
        resStatusMode: 'replace',
        resStatusOverride: status
      }
    },
    { ...base, action: { type: 'transform-response', statusOverride: status } },
    { enabled: true, method: 'GET', urlPattern: '/', response: { status } }
  ];

  for (const status of [100, 103, 199, 600]) {
    for (const rule of rulesForStatus(status)) {
      assert.match(validateMockRule(rule), /integer from 200 to 599/, String(status));
    }
  }
  for (const status of [200, 599]) {
    for (const rule of rulesForStatus(status)) {
      assert.equal(validateMockRule(rule), null, String(status));
    }
  }
});

test('persisted and runtime informational mock rules are discarded or skipped', () => {
  const proxy = new ProxyServer(null);
  const informational = status => ({
    id: `status-${status}`,
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status, body: 'unsafe informational response' }
  });
  const finalRule = validRule('status-599');
  finalRule.action.status = 599;

  const restored = proxy.loadMockRules([
    informational(100),
    { type: 'group', id: 'mixed-statuses', items: [informational(199), finalRule] }
  ]);

  assert.equal(restored.migrated, true);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['mixed-statuses']);
  assert.deepEqual(proxy.mockRules[0].items.map(rule => rule.id), ['status-599']);

  const runtimeFallback = validRule('runtime-final');
  proxy.mockRules = [informational(199), runtimeFallback];
  assert.equal(
    proxy._findMockRule('GET', 'https://example.test/', {}, ''),
    runtimeFallback
  );
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

  const matcherUpdate = await requestJson(port, 'PUT', `/api/mock-rules/${rule.id}`, {
    matchers: [{ type: 'port', value: '65536' }]
  });

  assert.equal(matcherUpdate.statusCode, 400);
  assert.match(matcherUpdate.body.error, /1 through 65535/);
  assert.deepEqual(rule, before);
});

test('mock import rejects non-boolean enabled values without changing existing rules', async t => {
  const { proxy, port } = await createApi(t);
  proxy.mockRules = [validRule('existing')];
  const before = structuredClone(proxy.mockRules);

  const leafResult = await requestJson(port, 'PUT', '/api/mock-rules', {
    rules: [{
      enabled: 'false',
      matchers: [{ type: 'method', value: 'GET' }],
      action: { type: 'fixed-response' }
    }]
  });
  assert.equal(leafResult.statusCode, 400);
  assert.deepEqual(proxy.mockRules, before);

  const groupResult = await requestJson(port, 'PUT', '/api/mock-rules', {
    rules: [{ type: 'group', enabled: 1, items: [validRule('nested')] }]
  });
  assert.equal(groupResult.statusCode, 400);
  assert.deepEqual(proxy.mockRules, before);
});

test('combined rule imports preserve false enabled values and default omissions to true', async t => {
  const { proxy, port } = await createApi(t);
  const importedRule = (title, enabled) => ({
    title,
    ...(enabled === undefined ? {} : { enabled }),
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response' }
  });

  const result = await requestJson(port, 'PUT', '/api/rules', {
    mockRules: [
      importedRule('disabled leaf', false),
      importedRule('default leaf'),
      {
        type: 'group',
        title: 'disabled group',
        enabled: false,
        items: [importedRule('disabled group child')]
      },
      {
        type: 'group',
        title: 'default group',
        items: [importedRule('default group child')]
      }
    ],
    breakpointRules: []
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(proxy.mockRules.map(rule => [rule.title, rule.enabled]), [
    ['disabled leaf', false],
    ['default leaf', true],
    ['disabled group', false],
    ['default group', true]
  ]);
  assert.equal(proxy.mockRules[2].items[0].enabled, true);
  assert.equal(proxy.mockRules[3].items[0].enabled, true);
});

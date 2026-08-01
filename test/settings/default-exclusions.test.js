import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import {
  DEFAULT_EXCLUSIONS,
  matchesDefaultExclusion,
  normalizeDefaultExclusions
} from '../../src/traffic/default-exclusions.js';
import {
  createTrafficListVisibilityMatcher,
  createDefaultTrafficList,
  filterTrafficLists,
  normalizeTrafficLists
} from '../../src/traffic/traffic-lists.js';

function requestJson(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : undefined
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

async function createApi(t, initialSettings = {}) {
  const values = { ...initialSettings };
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null,
    getStats: () => ({})
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = {
    get(key, fallback) {
      return Object.hasOwn(values, key) ? values[key] : fallback;
    },
    setAll(changes) {
      Object.assign(values, changes);
    }
  };
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, port: server.address().port, values };
}

test('the default list contains and matches the restored Chromium background exclusions', () => {
  assert.equal(DEFAULT_EXCLUSIONS.includes('android.clients.google.com/c2dm/register3'), true);
  assert.equal(matchesDefaultExclusion({
    url: 'https://android.clients.google.com/c2dm/register3?app=com.android.chrome'
  }), true);
  assert.equal(matchesDefaultExclusion({
    host: 'android.clients.google.com',
    path: '/user-request'
  }), false);
  assert.equal(matchesDefaultExclusion({ host: 'cache.gvt1.com', path: '/asset' }), true);
  assert.equal(matchesDefaultExclusion({ host: 'my-update-service.googleapis.com', path: '/' }), true);
});

test('exclusion patterns normalize URLs, comments, case, and duplicates', () => {
  assert.deepEqual(normalizeDefaultExclusions([
    '# comment',
    ' HTTPS://Android.Clients.Google.com/c2dm/register3 ',
    'android.clients.google.com/c2dm/register3',
    ''
  ]), ['android.clients.google.com/c2dm/register3']);
  assert.throws(
    () => normalizeDefaultExclusions(['not a host name']),
    /invalid hostname pattern/
  );
  assert.throws(() => normalizeDefaultExclusions('example.com'), /must be an array/);
});

test('shared renderer filtering applies draft hostname and path patterns', () => {
  let isVisible = createTrafficListVisibilityMatcher([{
      id: 'custom-blacklist',
      name: 'Custom blacklist',
      enabled: true,
      mode: 'blacklist',
      patterns: [
        'HTTPS://Android.Clients.Google.com/c2dm/register3',
        'temporarily invalid host name'
      ]
    }], { ignoreInvalidPatterns: true });
  assert.equal(isVisible({
    url: 'https://android.clients.google.com/c2dm/register3?app=chrome'
  }), false);
  assert.equal(isVisible({
    url: 'https://android.clients.google.com/checkin'
  }), true);

  isVisible = createTrafficListVisibilityMatcher([{
    id: 'custom-whitelist',
    name: 'Custom whitelist',
    enabled: true,
    mode: 'whitelist',
    patterns: ['allowed.example']
  }], { ignoreInvalidPatterns: true });
  assert.equal(isVisible({
    url: 'https://android.clients.google.com/c2dm/register3'
  }), false);
  assert.equal(isVisible({ url: 'https://allowed.example/path' }), true);
});

test('renderer plus and minus controls insert and remove the intended rules', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function insertTrafficListPattern(');
  const end = source.indexOf('function createTrafficListRuleRow(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  let changeCalls = 0;
  const context = {
    trafficLists: [{ id: 'custom', patterns: ['first', 'last'] }],
    expandedTrafficListIds: new Set(),
    renderTrafficListsEditor() {},
    markTrafficListsChanged() { changeCalls++; },
    focusTrafficListPattern() {},
    persistTrafficListAccordionState() {}
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nthis.insertRule = insertTrafficListPattern; this.removeRule = removeTrafficListPattern;`,
    context
  );
  context.insertRule('custom', 0);
  assert.deepEqual(Array.from(context.trafficLists[0].patterns), ['first', '', 'last']);
  context.removeRule('custom', 1);
  assert.deepEqual(Array.from(context.trafficLists[0].patterns), ['first', 'last']);
  assert.equal(changeCalls, 2);
});

test('renderer accordions restore and persist expanded list IDs', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function loadTrafficListAccordionState(');
  const end = source.indexOf('function trafficListModeHelp(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const savedValues = [];
  let renderCalls = 0;
  const context = {
    trafficListAccordionStateLoaded: false,
    expandedTrafficListIds: new Set(['default-exclusions']),
    safeLocalStorageGet: () => '["custom-list"]',
    safeLocalStorageSet: (_key, value) => savedValues.push(value),
    renderTrafficListsEditor: () => { renderCalls++; }
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\n` +
    'this.loadAccordion = loadTrafficListAccordionState; ' +
    'this.toggleAccordion = toggleTrafficListAccordion;',
    context
  );
  context.loadAccordion();
  assert.deepEqual(Array.from(context.expandedTrafficListIds), ['custom-list']);
  context.toggleAccordion('custom-list');
  assert.deepEqual(Array.from(context.expandedTrafficListIds), []);
  assert.equal(savedValues.at(-1), '[]');
  context.toggleAccordion('default-exclusions');
  assert.deepEqual(Array.from(context.expandedTrafficListIds), ['default-exclusions']);
  assert.equal(renderCalls, 2);
});

test('traffic lists combine whitelists as a union and give blacklists precedence', () => {
  const requests = [
    { id: 'api', host: 'api.example.test', path: '/v1/users' },
    { id: 'admin', host: 'admin.example.test', path: '/dashboard' },
    { id: 'blocked', host: 'api.example.test', path: '/private/token' },
    { id: 'other', host: 'other.example.test', path: '/' }
  ];
  const lists = normalizeTrafficLists([
    { ...createDefaultTrafficList(), enabled: false },
    {
      id: 'allowed-services',
      name: 'Allowed services',
      enabled: true,
      mode: 'whitelist',
      patterns: ['api.example.test']
    },
    {
      id: 'allowed-admin',
      name: 'Allowed admin',
      enabled: true,
      mode: 'whitelist',
      patterns: ['admin.example.test']
    },
    {
      id: 'blocked-private',
      name: 'Blocked private paths',
      enabled: true,
      mode: 'blacklist',
      patterns: ['api.example.test/private']
    }
  ]);
  assert.deepEqual(
    filterTrafficLists(requests, lists).map(request => request.id),
    ['api', 'admin']
  );
});

test('traffic lists keep WebSocket frames in step with their parent visibility', () => {
  const lists = normalizeTrafficLists([
    { ...createDefaultTrafficList(), enabled: false },
    {
      id: 'socket-whitelist',
      name: 'Socket whitelist',
      enabled: true,
      mode: 'whitelist',
      patterns: ['allowed.example']
    }
  ]);
  const requests = [
    { id: 'allowed', trafficLifecycleId: 'a', protocol: 'wss', host: 'allowed.example' },
    { id: 'allowed-frame', protocol: 'ws-frame', parentId: 'allowed', parentTrafficLifecycleId: 'a' },
    { id: 'hidden', trafficLifecycleId: 'b', protocol: 'wss', host: 'hidden.example' },
    { id: 'hidden-frame', protocol: 'ws-frame', parentId: 'hidden', parentTrafficLifecycleId: 'b' }
  ];
  assert.deepEqual(
    filterTrafficLists(requests, lists).map(request => request.id),
    ['allowed', 'allowed-frame']
  );
});

test('traffic list validation requires the built-in list and valid unique metadata', () => {
  assert.throws(() => normalizeTrafficLists([]), /Default Exclusions list is required/);
  assert.throws(() => normalizeTrafficLists([
    createDefaultTrafficList(),
    { id: 'custom', name: 'Custom', enabled: true, mode: 'invalid', patterns: [] }
  ]), /mode must be blacklist or whitelist/);
  assert.throws(() => normalizeTrafficLists([
    createDefaultTrafficList(),
    { id: 'default-exclusions', name: 'Duplicate', enabled: true, mode: 'blacklist', patterns: [] }
  ]), /id must be unique/);
});

test('Default Exclusions API is enabled by default, persists edits, and controls traffic queries', async t => {
  const { api, port, values } = await createApi(t);
  api.trafficLog.push(
    {
      id: 'background',
      method: 'POST',
      host: 'android.clients.google.com',
      path: '/c2dm/register3',
      url: 'https://android.clients.google.com/c2dm/register3'
    },
    {
      id: 'wanted',
      method: 'GET',
      host: 'example.test',
      path: '/wanted',
      url: 'https://example.test/wanted'
    }
  );

  const defaults = await requestJson(port, 'GET', '/api/default-exclusions');
  assert.equal(defaults.statusCode, 200);
  assert.equal(defaults.body.enabled, true);
  assert.equal(defaults.body.patterns.includes('android.clients.google.com/c2dm/register3'), true);
  assert.deepEqual(defaults.body.defaults, defaults.body.patterns);

  const filtered = await requestJson(port, 'GET', '/api/traffic?limit=100');
  assert.equal(filtered.body.total, 1);
  assert.deepEqual(filtered.body.requests.map(request => request.id), ['wanted']);
  assert.deepEqual(api._getHarExportTraffic().map(request => request.id), ['wanted']);

  const saved = await requestJson(port, 'PUT', '/api/default-exclusions', {
    enabled: false,
    patterns: [' EXAMPLE.TEST/private ', 'example.test/private']
  });
  assert.deepEqual(saved, {
    statusCode: 200,
    body: {
      success: true,
      enabled: false,
      patterns: ['example.test/private']
    }
  });
  assert.deepEqual(values, {
    trafficLists: [{
      id: 'default-exclusions',
      name: 'Default Exclusions',
      enabled: false,
      mode: 'blacklist',
      patterns: ['example.test/private']
    }],
    defaultExclusionsEnabled: false,
    defaultExclusions: ['example.test/private']
  });

  const unfiltered = await requestJson(port, 'GET', '/api/traffic?limit=100');
  assert.equal(unfiltered.body.total, 2);
  assert.deepEqual(unfiltered.body.requests.map(request => request.id), ['background', 'wanted']);
});

test('Traffic Lists API migrates legacy settings and persists custom whitelist lists', async t => {
  const { api, port, values } = await createApi(t, {
    defaultExclusionsEnabled: false,
    defaultExclusions: ['legacy-background.test']
  });
  api.trafficLog.push(
    { id: 'allowed', host: 'allowed.example', path: '/api' },
    { id: 'blocked', host: 'blocked.example', path: '/' }
  );

  const migrated = await requestJson(port, 'GET', '/api/traffic-lists');
  assert.equal(migrated.statusCode, 200);
  assert.deepEqual(migrated.body.lists, [{
    id: 'default-exclusions',
    name: 'Default Exclusions',
    enabled: false,
    mode: 'blacklist',
    patterns: ['legacy-background.test'],
    builtIn: true
  }]);

  const lists = [
    migrated.body.lists[0],
    {
      id: 'my-whitelist',
      name: 'My Whitelist',
      enabled: true,
      mode: 'whitelist',
      patterns: ['allowed.example']
    }
  ];
  const saved = await requestJson(port, 'PUT', '/api/traffic-lists', { lists });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.success, true);
  assert.equal(saved.body.lists.length, 2);
  assert.equal(values.trafficLists.length, 2);

  const traffic = await requestJson(port, 'GET', '/api/traffic?limit=100');
  assert.deepEqual(traffic.body.requests.map(request => request.id), ['allowed']);
});

test('Traffic Lists API rejects invalid collections and reports persistence failures', async t => {
  const { api, port, values } = await createApi(t);
  const missingDefault = await requestJson(port, 'PUT', '/api/traffic-lists', {
    lists: [{
      id: 'custom-only',
      name: 'Custom only',
      enabled: true,
      mode: 'blacklist',
      patterns: []
    }]
  });
  assert.equal(missingDefault.statusCode, 400);
  assert.match(missingDefault.body.error, /Default Exclusions list is required/);

  api.settings.setAll = () => { throw new Error('disk full'); };
  const failedSave = await requestJson(port, 'PUT', '/api/traffic-lists', {
    lists: [createDefaultTrafficList()]
  });
  assert.deepEqual(failedSave, {
    statusCode: 500,
    body: { error: 'disk full' }
  });
  assert.deepEqual(values, {});
});

test('Default Exclusions API rejects malformed edits without changing settings', async t => {
  const { port, values } = await createApi(t);
  const response = await requestJson(port, 'PUT', '/api/default-exclusions', {
    enabled: true,
    patterns: ['bad host name']
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /invalid hostname pattern/);
  assert.deepEqual(values, {});
});

test('Default Exclusions API reports persistence failures without claiming success', async t => {
  const { api, port, values } = await createApi(t);
  api.settings.setAll = () => { throw new Error('disk full'); };
  const response = await requestJson(port, 'PUT', '/api/default-exclusions', {
    enabled: false,
    patterns: ['example.test']
  });
  assert.deepEqual(response, {
    statusCode: 500,
    body: { error: 'disk full' }
  });
  assert.deepEqual(values, {});
});

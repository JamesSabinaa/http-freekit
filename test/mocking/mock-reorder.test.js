import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import http from 'node:http';
import os from 'node:os';
import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const reorderStart = rendererSource.indexOf('let mockDragId = null;');
const reorderEnd = rendererSource.indexOf('function combineRulesAsGroup', reorderStart);
assert.ok(reorderStart >= 0 && reorderEnd > reorderStart, 'mock reorder functions must be present');
const reorderSource = rendererSource.slice(reorderStart, reorderEnd);

const serverRules = [
  { id: 'a', title: 'Rule A' },
  { id: 'b', title: 'Server Rule B' },
  { id: 'c', title: 'Rule C' }
];

function jsonResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function createHarness(fetchImpl, initialRules) {
  const requests = [];
  const toasts = [];
  let renderCount = 0;
  const context = {
    API_BASE: '',
    console,
    document: { querySelectorAll: () => [] },
    fetch: (url, options = {}) => {
      requests.push({
        url,
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null
      });
      return fetchImpl(url, options);
    },
    renderMockRules: () => { renderCount++; },
    updateMockSaveButtons: () => {},
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockRules = ${JSON.stringify(initialRules || [
      serverRules[0],
      { ...serverRules[1], title: 'Draft Rule B' },
      serverRules[2]
    ])};
    const mockDraftRules = new Map([['b', { id: 'b', title: 'Draft Rule B' }]]);
    const mockNewDraftIds = new Set();
    let breakpointRules = [];
    let mockExpandedRules = new Set();
    let mockSaveInProgress = false;
    function _applyDraftToLocal(ruleId, draft) {
      const rule = mockRules.flatMap(candidate => [candidate, ...(candidate.items || [])]).find(candidate => candidate.id === ruleId);
      if (rule) Object.assign(rule, draft);
    }
    ${reorderSource}
    globalThis.beginMockDrag = id => { mockDragId = id; };
    globalThis.dropMockRule = targetId => mockDrop({
      preventDefault() {},
      shiftKey: false
    }, targetId);
    globalThis.getMockRules = () => JSON.parse(JSON.stringify(mockRules));
  `, context);

  return {
    context,
    requests,
    toasts,
    get renderCount() { return renderCount; },
    rules: () => JSON.parse(JSON.stringify(context.getMockRules()))
  };
}

function ruleIds(harness) {
  return harness.rules().map(rule => rule.id);
}

function groupedRules() {
  return [{ id: 'group', type: 'group', enabled: true, items: ['a', 'b'].map(id => ({
    id, enabled: true, matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200, body: id }
  })) }, { id: 'outside', enabled: true, matchers: [{ type: 'wildcard' }], action: { type: 'passthrough' } }];
}

test('child drag order reaches the live API and changes matching priority without losing drafts', async t => {
  const proxy = new ProxyServer(null);
  proxy.mockRules = groupedRules();
  const api = new ApiServer(proxy, null, null);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-child-reorder-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  api.settings = new Settings(dataDir);
  const server = http.createServer(api.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const harness = createHarness((url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, options), groupedRules());
  harness.context.beginMockDrag('b');
  await harness.context.dropMockRule('a');
  assert.deepEqual(proxy.mockRules[0].items.map(rule => rule.id), ['b', 'a']);
  assert.deepEqual(new Settings(dataDir).get('mockRules')[0].items.map(rule => rule.id), ['b', 'a']);
  assert.equal(proxy._findMockRule('GET', 'http://example.test/', {}, '').action.body, 'b');
  assert.deepEqual(ruleIds(harness), ['group', 'outside']);
  assert.equal(harness.rules()[0].items[0].title, 'Draft Rule B');
  assert.equal(proxy.mockRules[0].items[0].title, undefined);
  const rejected = await fetch(`http://127.0.0.1:${server.address().port}/api/mock-rules/reorder`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['a'], groupId: 'outside' })
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(proxy.mockRules[0].items.map(rule => rule.id), ['b', 'a']);
});

test('failed child reorders restore their sibling order when reload also fails', async () => {
  const harness = createHarness(async () => { throw new Error('offline'); }, groupedRules());
  harness.context.beginMockDrag('b');
  await harness.context.dropMockRule('a');
  assert.deepEqual(harness.rules()[0].items.map(rule => rule.id), ['a', 'b']);
  assert.deepEqual(ruleIds(harness), ['group', 'outside']);
  assert.match(harness.toasts[0].message, /Previous order restored/);
});

test('successful mock reorder stays optimistic and preserves local drafts', async () => {
  const harness = createHarness(async (_url, options) => {
    assert.equal(options.method, 'POST');
    return jsonResponse({
      success: true,
      rules: [serverRules[1], serverRules[2], serverRules[0]].map(rule => ({ ...rule }))
    });
  });

  harness.context.beginMockDrag('a');
  const pending = harness.context.dropMockRule('c');

  assert.deepEqual(ruleIds(harness), ['b', 'c', 'a']);
  assert.equal(harness.rules()[0].title, 'Draft Rule B');
  assert.equal(harness.renderCount, 1);

  await pending;

  assert.deepEqual(harness.requests, [{
    url: '/api/mock-rules/reorder',
    method: 'POST',
    body: { ids: ['b', 'c', 'a'] }
  }]);
  assert.deepEqual(ruleIds(harness), ['b', 'c', 'a']);
  assert.equal(harness.rules()[0].title, 'Draft Rule B');
  assert.equal(harness.renderCount, 2);
  assert.deepEqual(harness.toasts, []);
});

test('rejected mock reorders reload authoritative order and report each failure mode', async () => {
  const scenarios = [
    {
      name: 'HTTP rejection',
      post: async () => jsonResponse({ error: 'disk unavailable' }, { ok: false, status: 503 }),
      message: 'disk unavailable'
    },
    {
      name: 'network failure',
      post: async () => { throw new Error('offline'); },
      message: 'offline'
    },
    {
      name: 'invalid JSON',
      post: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('bad JSON'); }
      }),
      message: 'Reordering mock rules returned invalid JSON'
    }
  ];

  for (const scenario of scenarios) {
    const harness = createHarness((url, options) => {
      if (options.method === 'POST') return scenario.post();
      return jsonResponse({ rules: serverRules.map(rule => ({ ...rule })) });
    });
    harness.context.beginMockDrag('a');

    await harness.context.dropMockRule('c');

    assert.deepEqual(ruleIds(harness), ['a', 'b', 'c'], scenario.name);
    assert.equal(harness.rules()[1].title, 'Draft Rule B', scenario.name);
    assert.deepEqual(harness.requests.map(request => request.method), ['POST', 'GET'], scenario.name);
    assert.deepEqual(harness.toasts, [{
      message: `Rule reorder failed: ${scenario.message}. Server order restored.`,
      type: 'error'
    }], scenario.name);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('late older reorder responses cannot roll back a newer optimistic reorder', async () => {
  for (const olderResult of ['success', 'failure']) {
    const first = deferred();
    const second = deferred();
    let postCount = 0;
    const harness = createHarness((_url, options) => {
      assert.equal(options.method, 'POST', 'a superseded failure must not trigger a reload');
      return (++postCount === 1 ? first : second).promise;
    });

    harness.context.beginMockDrag('a');
    const older = harness.context.dropMockRule('c');
    harness.context.beginMockDrag('b');
    const newer = harness.context.dropMockRule('a');

    assert.deepEqual(ruleIds(harness), ['c', 'a', 'b'], olderResult);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.requests.length, 1, 'reorder writes must be serialized');

    first.resolve(olderResult === 'success'
      ? jsonResponse({
          success: true,
          rules: [serverRules[1], serverRules[2], serverRules[0]].map(rule => ({ ...rule }))
        })
      : jsonResponse({ error: 'older failed' }, { ok: false, status: 500 }));
    await older;
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(ruleIds(harness), ['c', 'a', 'b'], olderResult);
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(harness.requests[1].body, { ids: ['c', 'a', 'b'] });
    second.resolve(jsonResponse({
      success: true,
      rules: [serverRules[2], serverRules[0], serverRules[1]].map(rule => ({ ...rule }))
    }));
    await newer;

    assert.deepEqual(ruleIds(harness), ['c', 'a', 'b'], olderResult);
    assert.equal(harness.rules()[2].title, 'Draft Rule B', olderResult);
    assert.deepEqual(harness.toasts, [], olderResult);
  }
});

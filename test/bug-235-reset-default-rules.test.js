import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const resetStart = source.indexOf('function _createDefaultMockRule()');
const resetEnd = source.indexOf('function collapseAllMockRules()', resetStart);
assert.notEqual(resetStart, -1);
assert.notEqual(resetEnd, -1);
const resetSource = source.slice(resetStart, resetEnd);
const loadStart = source.indexOf('async function loadMockRules()');
const loadEnd = source.indexOf('async function ensureDefaultMockRules()', loadStart);
assert.notEqual(loadStart, -1);
assert.notEqual(loadEnd, -1);
const loadSource = source.slice(loadStart, loadEnd);
const queueStart = source.indexOf('function _queueMockCollectionMutation(');
const queueEnd = source.indexOf('function mockDrop(', queueStart);
const combineStart = source.indexOf('function combineRulesAsGroup(');
const combineEnd = source.indexOf('function mockDragEnd(', combineStart);
assert.notEqual(queueStart, -1);
assert.notEqual(queueEnd, -1);
assert.notEqual(combineStart, -1);
assert.notEqual(combineEnd, -1);
const queueSource = source.slice(queueStart, queueEnd);
const combineSource = source.slice(combineStart, combineEnd);

function response(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function putJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function createRenderer(fetch) {
  const requests = [];
  const toasts = [];
  const storage = new Map();
  const context = {
    API_BASE: '',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetch(url, options);
    },
    toast: (message, type) => toasts.push({ message, type }),
    safeLocalStorageSet: (key, value) => { storage.set(key, value); return true; }
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockRules = [{ id: 'old', title: 'Old rule' }];
    const mockDraftRules = new Map([['old', { id: 'old', title: 'Draft' }]]);
    const mockNewDraftIds = new Set(['new-draft']);
    const mockExpandedRules = new Set(['old']);
    let mockEditingRule = 'old';
    let mockEditDraft = { id: 'old', title: 'Live edit' };
    let mockRenamingRuleId = 'old';
    let mockReorderGeneration = 0;
    let mockReorderQueue = Promise.resolve();
    let mockCollectionMutationCount = 0;
    let mockRulesLoadGeneration = 0;
    let mockResetInProgress = false;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let renders = 0;
    let buttonUpdates = 0;
    function _replaceMockRulesFromServer(rules) { mockRules = rules; }
    function updateMockSaveButtons() { buttonUpdates++; }
    function renderMockRules() { renders++; }
    async function loadBreakpointRules() {}
    async function _readMockRulesResponse(res, action) {
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || action + ' failed with HTTP ' + res.status);
      return data;
    }
    ${resetSource}
    async function _fetchAuthoritativeMockRules(action) {
      const response = await fetch(API_BASE + '/api/mock-rules');
      const data = await _readMockRulesResponse(response, action);
      if (!Array.isArray(data?.rules)) throw new Error(action + ' returned an invalid response');
      return data.rules;
    }
    ${loadSource}
    ${queueSource}
    ${combineSource}
    globalThis.queueMockReorder = promise => {
      const operation = ++mockReorderGeneration;
      mockReorderQueue = promise.then(rules => {
        if (operation === mockReorderGeneration) mockRules = rules;
      });
    };
  `, context);

  return {
    context,
    requests,
    storage,
    toasts,
    state: () => JSON.parse(vm.runInContext(`JSON.stringify({
      mockRules,
      drafts: Array.from(mockDraftRules.entries()),
      newDraftIds: Array.from(mockNewDraftIds),
      expanded: Array.from(mockExpandedRules),
      mockEditingRule,
      mockEditDraft,
      mockRenamingRuleId,
      renders,
      buttonUpdates,
      mockResetInProgress
    })`, context))
  };
}

test('Reset atomically replaces every rule with the shipped default and clears local drafts', async () => {
  const authoritativeDefault = {
    id: 'server-default',
    title: 'Default: Pass through all requests',
    enabled: true,
    priority: 'normal',
    matchers: [{ type: 'method', value: '*' }],
    action: { type: 'passthrough' }
  };
  const renderer = createRenderer(async () => response({
    success: true,
    rules: [authoritativeDefault]
  }));

  await renderer.context.clearAllMockRules();

  assert.equal(renderer.requests.length, 1);
  assert.equal(renderer.requests[0].url, '/api/mock-rules');
  assert.equal(renderer.requests[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(renderer.requests[0].options.body), {
    mode: 'replace',
    rules: [{
      title: 'Default: Pass through all requests',
      enabled: true,
      priority: 'normal',
      matchers: [{ type: 'method', value: '*' }],
      action: { type: 'passthrough' }
    }]
  });
  assert.deepEqual(renderer.state(), {
    mockRules: [authoritativeDefault],
    drafts: [],
    newDraftIds: [],
    expanded: [],
    mockEditingRule: null,
    mockEditDraft: null,
    mockRenamingRuleId: null,
    renders: 1,
    buttonUpdates: 3,
    mockResetInProgress: false
  });
  assert.equal(renderer.storage.get('http-freekit-defaults-created'), 'true');
  assert.deepEqual(renderer.toasts, [{ message: 'Rules reset to default', type: 'success' }]);
});

test('a failed Reset preserves every current rule, draft, and editor state', async () => {
  const renderer = createRenderer(async () => response(
    { error: 'settings write failed' },
    { ok: false, status: 500 }
  ));
  const before = renderer.state();

  await renderer.context.clearAllMockRules();

  const after = renderer.state();
  assert.deepEqual({ ...after, buttonUpdates: before.buttonUpdates }, before);
  assert.equal(after.buttonUpdates, before.buttonUpdates + 2);
  assert.equal(renderer.storage.size, 0);
  assert.deepEqual(renderer.toasts, [{ message: 'Error: settings write failed', type: 'error' }]);
});

test('Reset remains available when the current rule list is empty', async () => {
  const renderer = createRenderer(async () => response({
    success: true,
    rules: [{ id: 'default', matchers: [], action: { type: 'passthrough' } }]
  }));
  vm.runInContext('mockRules = []', renderer.context);

  await renderer.context.clearAllMockRules();

  assert.equal(renderer.requests.length, 1);
  assert.equal(renderer.state().mockRules[0].id, 'default');
});

test('a delayed rule load cannot overwrite a successful Reset', async () => {
  let resolveLoad;
  const delayedLoad = new Promise(resolve => { resolveLoad = resolve; });
  const renderer = createRenderer((url, options = {}) => {
    if ((options.method || 'GET') === 'GET') return delayedLoad;
    return response({
      success: true,
      rules: [{ id: 'default', title: 'Default', action: { type: 'passthrough' } }]
    });
  });

  const loading = renderer.context.loadMockRules();
  await Promise.resolve();
  await renderer.context.clearAllMockRules();
  resolveLoad(response({ rules: [{ id: 'stale', title: 'Stale rule' }] }));
  await loading;

  assert.deepEqual(renderer.state().mockRules, [
    { id: 'default', title: 'Default', action: { type: 'passthrough' } }
  ]);
});

test('Reset waits for queued reorders and remains the final collection mutation', async () => {
  let resolveReorder;
  const queuedReorder = new Promise(resolve => { resolveReorder = resolve; });
  const renderer = createRenderer(async () => response({
    success: true,
    rules: [{ id: 'default', title: 'Default', action: { type: 'passthrough' } }]
  }));
  renderer.context.queueMockReorder(queuedReorder);

  const resetting = renderer.context.clearAllMockRules();
  await Promise.resolve();
  assert.equal(renderer.requests.length, 0);
  assert.equal(renderer.state().mockResetInProgress, true);

  resolveReorder([{ id: 'old', title: 'Reordered old rule' }]);
  await resetting;

  assert.equal(renderer.requests.length, 1);
  assert.deepEqual(renderer.state().mockRules, [
    { id: 'default', title: 'Default', action: { type: 'passthrough' } }
  ]);
  assert.equal(renderer.state().mockResetInProgress, false);
});

test('Reset remains final when an older Shift-drop combine is in flight', async () => {
  let resolveCombine;
  const delayedCombine = new Promise(resolve => { resolveCombine = resolve; });
  const renderer = createRenderer((url) => {
    if (url.endsWith('/combine')) return delayedCombine;
    return response({
      success: true,
      rules: [{ id: 'default', title: 'Default', action: { type: 'passthrough' } }]
    });
  });

  const combining = renderer.context.combineRulesAsGroup('old', 'other');
  await Promise.resolve();
  const resetting = renderer.context.clearAllMockRules();
  await Promise.resolve();
  assert.deepEqual(renderer.requests.map(request => request.url), ['/api/mock-rules/combine']);

  resolveCombine(response({
    success: true,
    group: { id: 'stale-group' },
    rules: [{ id: 'stale-group', type: 'group', items: [] }]
  }));
  await Promise.all([combining, resetting]);

  assert.deepEqual(renderer.requests.map(request => request.url), [
    '/api/mock-rules/combine',
    '/api/mock-rules'
  ]);
  assert.deepEqual(renderer.state().mockRules, [
    { id: 'default', title: 'Default', action: { type: 'passthrough' } }
  ]);
});

test('server persistence failure rolls an atomic default replacement back', async t => {
  const proxy = new ProxyServer(null);
  const existingRules = [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'passthrough' }
  }];
  proxy.mockRules = existingRules;
  const api = new ApiServer(proxy, null, null);
  api.settings = { set: () => { throw new Error('settings disk full'); } };
  api.app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await putJson(server.address().port, '/api/mock-rules', {
    mode: 'replace',
    rules: [{
      title: 'Default: Pass through all requests',
      enabled: true,
      priority: 'normal',
      matchers: [{ type: 'method', value: '*' }],
      action: { type: 'passthrough' }
    }]
  });

  assert.equal(result.statusCode, 500);
  assert.match(typeof result.body === 'string' ? result.body : result.body.error, /settings disk full/);
  assert.equal(proxy.mockRules, existingRules);
  assert.deepEqual(proxy.mockRules, [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'passthrough' }
  }]);
});

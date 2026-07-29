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
    let renders = 0;
    let buttonUpdates = 0;
    function _replaceMockRulesFromServer(rules) { mockRules = rules; }
    function updateMockSaveButtons() { buttonUpdates++; }
    function renderMockRules() { renders++; }
    async function _readMockRulesResponse(res, action) {
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || action + ' failed with HTTP ' + res.status);
      return data;
    }
    ${resetSource}
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
      buttonUpdates
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
    buttonUpdates: 1
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

  assert.deepEqual(renderer.state(), before);
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

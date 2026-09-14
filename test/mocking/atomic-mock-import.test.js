import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

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
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createServer(t) {
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

test('invalid replacement imports leave every existing mock rule intact', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  }];

  const result = await putJson(port, '/api/mock-rules', { rules: [{}] });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['existing']);
});

test('informational-status replacement imports are rejected atomically', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200, body: 'retained' }
  }];
  const before = structuredClone(proxy.mockRules);

  const result = await putJson(port, '/api/mock-rules', {
    rules: [{
      enabled: true,
      matchers: [{ type: 'method', value: 'GET' }],
      action: { type: 'fixed-response', status: 199, body: 'invalid' }
    }]
  });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.mockRules, before);
});

test('invalid transform and rewrite imports leave every existing mock rule intact', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200, body: 'retained' }
  }];
  const before = structuredClone(proxy.mockRules);

  for (const invalidRule of [
    {
      enabled: true,
      matchers: [{ type: 'wildcard' }],
      action: { type: 'transform-request', bodyMode: 'json-merge', body: '{bad json' }
    },
    {
      enabled: true,
      matchers: [{ type: 'wildcard' }],
      preSteps: [{ type: 'rewrite-url', value: 'ftp://example.test/' }],
      action: { type: 'passthrough' }
    },
    {
      enabled: true,
      matchers: [{ type: 'json-body-includes', value: '{bad json' }],
      action: { type: 'fixed-response', status: 200 }
    }
  ]) {
    const result = await putJson(port, '/api/mock-rules', {
      rules: [{
        enabled: true,
        matchers: [{ type: 'method', value: 'GET' }],
        action: { type: 'fixed-response', status: 201 }
      }, invalidRule]
    });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(proxy.mockRules, before);
  }
});

test('valid replacement imports are applied in one API operation', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{ id: 'existing', urlPattern: '/old', response: {} }];

  const result = await putJson(port, '/api/mock-rules', {
    rules: [{ matchers: [{ type: 'method', value: 'GET' }], action: { type: 'passthrough' } }]
  });

  assert.equal(result.statusCode, 200);
  assert.equal(proxy.mockRules.length, 1);
  assert.notEqual(proxy.mockRules[0].id, 'existing');
  assert.ok(proxy.mockRules[0].id);
});

test('renderer replacement import uses the atomic endpoint and checks failures', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function importMockRules()');
  const end = source.indexOf('// ============ TRANSFORM HEADER HELPERS', start);
  const importSource = source.slice(start, end);

  assert.match(importSource, /method: 'PUT'/);
  assert.match(importSource, /if \(!response\.ok\)/);
  assert.doesNotMatch(importSource, /method: 'DELETE'/);
});

test('replacement import clears obsolete editors and permits saving an imported rule', async t => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');
  const importStart = source.indexOf('function importMockRules()');
  const importSource = source.slice(importStart, source.indexOf('// ============ TRANSFORM HEADER HELPERS', importStart));
  const saveStart = source.indexOf('async function saveAllMockRules()');
  const saveSource = source.slice(saveStart, source.indexOf('/** Send a single draft rule', saveStart));
  for (const version of [1, 2]) {
    for (const mode of ['replace', 'append', 'rejected']) {
      const { proxy, port } = await createServer(t);
      const original = { id: 'existing', enabled: true, matchers: [{ type: 'wildcard' }],
        action: { type: 'fixed-response', status: 200, body: 'OLD' } };
      proxy.mockRules = [structuredClone(original)];
      let input;
      const toasts = [];
      const context = {
        API_BASE: `http://127.0.0.1:${port}`, fetch, original,
        RULE_RESTORE_ROUTE_MAX_BYTES: 50 * 1024 * 1024,
        confirm: () => mode !== 'append',
        document: { createElement: () => (input = { click() {} }) },
        toast: message => toasts.push(message),
        updateMockSaveButtons() {},
        _queueMockCollectionMutation: operation => operation(),
        loadMockRules: async () => { context.mockRules = structuredClone(proxy.mockRules); }
      };
      vm.createContext(context);
      vm.runInContext(`
        var mockRules = [original];
        var breakpointRules = [];
        var mockEditingRule = original.id;
        var mockEditDraft = structuredOriginal();
        function structuredOriginal() { return JSON.parse(JSON.stringify(original)); }
        var mockRenamingRuleId = original.id;
        var mockDraftRules = new Map([[original.id, mockEditDraft]]);
        var mockNewDraftIds = new Set();
        var mockSaveInProgress = false, mockRevertInProgress = false, mockResetInProgress = false;
        var mockCollectionMutationCount = 0, breakpointRulesLoadGeneration = 0;
        function hasOpenMockEditChanges() { return false; }
        function hasUnsavedMockChanges() { return mockDraftRules.size > 0; }
        ${importSource}
        ${saveSource}
      `, context);
      const imported = { ...original, action: { ...original.action, body: 'IMPORTED' } };
      const rules = mode === 'rejected' ? [{}] : [imported];
      const backup = version === 2 ? { version: 2, mockRules: rules, breakpointRules: [] } : { rules };
      context.importMockRules();
      await input.onchange({ target: { files: [{ text: async () => JSON.stringify(backup) }] } });
      if (mode !== 'replace') {
        assert.equal(context.mockEditingRule, original.id);
        assert.equal(context.mockEditDraft.action.body, 'OLD');
        assert.equal(context.mockRenamingRuleId, original.id);
        assert.equal(context.mockDraftRules.size, 1);
        continue;
      }
      assert.equal(context.mockEditingRule, null, `version ${version}`);
      assert.equal(context.mockEditDraft, null);
      assert.equal(context.mockRenamingRuleId, null);
      assert.equal(context.mockDraftRules.size, 0);
      const fresh = proxy.mockRules[0];
      assert.notEqual(fresh.id, original.id);
      context.mockDraftRules.set(fresh.id, { ...fresh, action: { ...fresh.action, body: 'NEW EDIT' } });
      await context.saveAllMockRules();
      assert.equal(proxy.mockRules[0].action.body, 'NEW EDIT');
      assert.equal(context.mockDraftRules.size, 0);
      assert.ok(toasts.includes('All changes saved'));
    }
  }
});

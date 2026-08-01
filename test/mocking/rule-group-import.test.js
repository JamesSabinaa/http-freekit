import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function mockRule(id, title) {
  return {
    id,
    title,
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  };
}

function mockGroup(id, title, items) {
  return { id, type: 'group', title, enabled: true, collapsed: false, items };
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

function collectIds(rules, ids = []) {
  for (const rule of rules) {
    ids.push(rule.id);
    if (rule.type === 'group') collectIds(rule.items, ids);
  }
  return ids;
}

test('atomic import restores mixed top-level groups and rules into an empty server', async t => {
  const { proxy, port } = await createServer(t);
  const exported = [
    mockGroup('duplicate', 'Exported Group', [mockRule('duplicate', 'Grouped Rule')]),
    mockRule('duplicate', 'Top-level Rule')
  ];

  const result = await requestJson(port, 'PUT', '/api/mock-rules', { rules: exported });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.rules.length, 2);
  assert.equal(result.body.rules[0].type, 'group');
  assert.equal(result.body.rules[0].title, 'Exported Group');
  assert.deepEqual(result.body.rules[0].items.map(rule => rule.title), ['Grouped Rule']);
  assert.equal(result.body.rules[1].title, 'Top-level Rule');
  assert.deepEqual(proxy.mockRules, result.body.rules);
  const ids = collectIds(result.body.rules);
  assert.equal(new Set(ids).size, ids.length, 'the server assigns every conflicting exported ID uniquely');
  assert.equal(ids.includes('duplicate'), false);
});

test('atomic append preserves the authoritative tree and appends an imported group', async t => {
  const { proxy, port } = await createServer(t);
  const existing = mockRule('existing-id', 'Existing Rule');
  proxy.mockRules = [existing];
  const imported = mockGroup('existing-id', 'Imported Group', [
    mockRule('existing-id', 'Imported Child')
  ]);

  const result = await requestJson(port, 'PUT', '/api/mock-rules', {
    mode: 'append',
    rules: [imported]
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.rules.length, 2);
  assert.equal(result.body.rules[0].id, existing.id);
  assert.equal(result.body.rules[0].title, existing.title);
  assert.equal(result.body.rules[1].type, 'group');
  assert.equal(result.body.rules[1].title, imported.title);
  const ids = collectIds(result.body.rules);
  assert.equal(new Set(ids).size, ids.length);
});

test('replacement removes the existing tree while invalid structured appends remain atomic', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [mockRule('existing-id', 'Existing Rule')];
  const replacement = mockGroup('replacement', 'Replacement Group', [
    mockRule('replacement-child', 'Replacement Child')
  ]);

  const replaced = await requestJson(port, 'PUT', '/api/mock-rules', { rules: [replacement] });
  assert.equal(replaced.statusCode, 200);
  assert.deepEqual(proxy.mockRules.map(rule => rule.title), ['Replacement Group']);

  const beforeInvalidAppend = structuredClone(proxy.mockRules);
  const invalid = await requestJson(port, 'PUT', '/api/mock-rules', {
    mode: 'append',
    rules: [mockGroup('outer', 'Outer', [mockGroup('inner', 'Nested', [])])]
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.error, /valid/);
  assert.deepEqual(proxy.mockRules, beforeInvalidAppend);

  const invalidMode = await requestJson(port, 'PUT', '/api/mock-rules', {
    mode: 'overwrite',
    rules: [mockRule('ordinary', 'Ordinary')]
  });
  assert.equal(invalidMode.statusCode, 400);
  assert.deepEqual(proxy.mockRules, beforeInvalidAppend);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const importStart = rendererSource.indexOf('function importMockRules()');
const importEnd = rendererSource.indexOf('// ============ TRANSFORM HEADER HELPERS', importStart);
assert.notEqual(importStart, -1);
assert.notEqual(importEnd, -1);
const importSource = rendererSource.slice(importStart, importEnd);

function createImportRenderer({ existingRules, importedRules, replace = false, fetch }) {
  const requests = [];
  const toasts = [];
  let completion;
  let confirmCalls = 0;
  let reloads = 0;
  const input = {
    click() {
      completion = input.onchange({
        target: {
          files: [{
            text: async () => JSON.stringify({ version: 1, rules: importedRules })
          }]
        }
      });
    }
  };
  const mockDraftRules = new Map([['draft', { id: 'draft' }]]);
  const mockNewDraftIds = new Set(['draft']);
  const context = {
    API_BASE: '',
    mockRules: structuredClone(existingRules),
    mockDraftRules,
    mockNewDraftIds,
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockResetInProgress: false,
    mockCollectionMutationCount: 0,
    _queueMockCollectionMutation: mutation => mutation(),
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'input');
        return input;
      }
    },
    confirm() {
      confirmCalls += 1;
      return replace;
    },
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return await fetch(url, options, requests.length - 1);
    },
    toast: (message, type) => toasts.push({ message, type }),
    loadMockRules: () => { reloads += 1; }
  };
  vm.createContext(context);
  vm.runInContext(`${importSource}\nthis.importMockRules = importMockRules;`, context);
  return {
    context,
    requests,
    toasts,
    mockDraftRules,
    mockNewDraftIds,
    get confirmCalls() { return confirmCalls; },
    get reloads() { return reloads; },
    async importRules() {
      context.importMockRules();
      await completion;
    }
  };
}

function successfulTreeResponse(rules) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, rules })
  };
}

test('empty and mixed group backups restore through one atomic renderer request', async () => {
  const importedRules = [
    mockGroup('group', 'Group', [mockRule('child', 'Child')]),
    mockRule('plain', 'Plain')
  ];
  const renderer = createImportRenderer({
    existingRules: [],
    importedRules,
    fetch: async () => successfulTreeResponse(importedRules)
  });

  await renderer.importRules();

  assert.equal(renderer.confirmCalls, 0);
  assert.equal(renderer.requests.length, 1);
  assert.equal(renderer.requests[0].url, '/api/mock-rules');
  assert.equal(renderer.requests[0].options.method, 'PUT');
  assert.deepEqual(renderer.requests[0].body, { rules: importedRules });
  assert.equal(renderer.mockDraftRules.size, 0);
  assert.equal(renderer.mockNewDraftIds.size, 0);
  assert.equal(renderer.reloads, 1);
  assert.deepEqual(renderer.toasts, [{ message: 'Imported 2 rules', type: 'success' }]);
});

test('existing group imports honor Replace and Append choices atomically', async t => {
  const existingRules = [mockRule('existing', 'Existing')];
  const importedRules = [mockGroup('group', 'Group', [mockRule('child', 'Child')])];

  await t.test('Replace', async () => {
    const renderer = createImportRenderer({
      existingRules,
      importedRules,
      replace: true,
      fetch: async () => successfulTreeResponse(importedRules)
    });
    await renderer.importRules();

    assert.equal(renderer.confirmCalls, 1);
    assert.equal(renderer.requests.length, 1);
    assert.equal(renderer.requests[0].options.method, 'PUT');
    assert.deepEqual(renderer.requests[0].body, { rules: importedRules });
    assert.equal(renderer.mockDraftRules.size, 0);
    assert.deepEqual(renderer.toasts, [{ message: 'Replaced with 1 rules', type: 'success' }]);
  });

  await t.test('Append', async () => {
    const renderer = createImportRenderer({
      existingRules,
      importedRules,
      replace: false,
      fetch: async () => successfulTreeResponse([...existingRules, ...importedRules])
    });
    await renderer.importRules();

    assert.equal(renderer.confirmCalls, 1);
    assert.equal(renderer.requests.length, 1);
    assert.equal(renderer.requests[0].options.method, 'PUT');
    assert.deepEqual(renderer.requests[0].body, { rules: importedRules, mode: 'append' });
    assert.equal(renderer.mockDraftRules.size, 1, 'append keeps unrelated unsaved drafts');
    assert.deepEqual(renderer.toasts, [{ message: 'Imported 1 rules', type: 'success' }]);
  });
});

test('structured import server rejection produces no success toast or reload', async () => {
  const importedRules = [mockGroup('group', 'Group', [mockRule('child', 'Child')])];
  const renderer = createImportRenderer({
    existingRules: [],
    importedRules,
    fetch: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Conflicting rule IDs' })
    })
  });

  await renderer.importRules();

  assert.equal(renderer.requests.length, 1);
  assert.equal(renderer.reloads, 0);
  assert.equal(renderer.mockDraftRules.size, 1);
  assert.deepEqual(renderer.toasts, [{
    message: 'Import failed: Conflicting rule IDs',
    type: 'error'
  }]);
});

test('failed flat replacement preserves drafts until an atomic import succeeds', async () => {
  const importedRules = [mockRule('replacement', 'Replacement')];
  const renderer = createImportRenderer({
    existingRules: [mockRule('existing', 'Existing')],
    importedRules,
    replace: true,
    fetch: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'disk full' })
    })
  });

  await renderer.importRules();

  assert.equal(renderer.requests.length, 1);
  assert.equal(renderer.requests[0].options.method, 'PUT');
  assert.deepEqual(renderer.requests[0].body, { rules: importedRules });
  assert.equal(renderer.mockDraftRules.size, 1);
  assert.equal(renderer.mockNewDraftIds.size, 1);
  assert.equal(renderer.reloads, 0);
  assert.deepEqual(renderer.toasts, [{
    message: 'Import failed: disk full',
    type: 'error'
  }]);
});

test('ordinary flat rule append uses one atomic tree request', async () => {
  const existingRules = [mockRule('existing', 'Existing')];
  const importedRules = [mockRule('first', 'First'), mockRule('second', 'Second')];
  const renderer = createImportRenderer({
    existingRules,
    importedRules,
    replace: false,
    fetch: async () => successfulTreeResponse([...existingRules, ...importedRules])
  });

  await renderer.importRules();

  assert.equal(renderer.requests.length, 1);
  assert.equal(renderer.requests[0].options.method, 'PUT');
  assert.deepEqual(renderer.requests[0].body, { rules: importedRules, mode: 'append' });
  assert.equal(renderer.mockDraftRules.size, 1);
  assert.equal(renderer.reloads, 1);
  assert.deepEqual(renderer.toasts, [{ message: 'Imported 2 rules', type: 'success' }]);
});

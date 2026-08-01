import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
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

async function createServer(t, settings) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { proxy, port: server.address().port };
}

test('combining rules persists one complete group in the existing ordering', async t => {
  const writes = [];
  const { proxy, port } = await createServer(t, {
    set: (key, value) => writes.push([key, JSON.parse(JSON.stringify(value))])
  });
  const dragged = { id: 'dragged', enabled: true };
  const target = { id: 'target', enabled: true };
  proxy.mockRules = [
    { id: 'existing-group', type: 'group', items: [dragged] },
    { id: 'untouched', enabled: true },
    target
  ];

  const result = await postJson(port, '/api/mock-rules/combine', {
    title: 'New Group',
    ruleIds: ['dragged', 'target']
  });

  assert.equal(result.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'mockRules');
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), [
    'existing-group', 'untouched', result.body.group.id
  ]);
  assert.deepEqual(proxy.mockRules[0].items, []);
  assert.deepEqual(proxy.mockRules[2].items.map(rule => rule.id), ['dragged', 'target']);
  assert.deepEqual(result.body.rules, writes[0][1]);
  assert.deepEqual(result.body.group, result.body.rules[2]);
});

test('a missing second rule leaves both source state and persistence untouched', async t => {
  let writes = 0;
  const { proxy, port } = await createServer(t, { set: () => { writes++; } });
  proxy.mockRules = [
    { id: 'first', enabled: true },
    { id: 'untouched', enabled: true }
  ];
  const previousRules = proxy.mockRules;
  const previousSnapshot = JSON.parse(JSON.stringify(previousRules));

  const result = await postJson(port, '/api/mock-rules/combine', {
    ruleIds: ['first', 'deleted-second']
  });

  assert.equal(result.statusCode, 404);
  assert.match(result.body.error, /rule not found/i);
  assert.equal(writes, 0);
  assert.equal(proxy.mockRules, previousRules);
  assert.deepEqual(proxy.mockRules, previousSnapshot);
  assert.equal(proxy.mockRules.some(rule => rule.type === 'group'), false);
});

test('duplicate or ungroupable source IDs are rejected before mutation', async t => {
  let writes = 0;
  const { proxy, port } = await createServer(t, { set: () => { writes++; } });
  proxy.mockRules = [
    { id: 'plain', enabled: true },
    { id: 'group', type: 'group', items: [] }
  ];
  const previousRules = proxy.mockRules;

  const duplicate = await postJson(port, '/api/mock-rules/combine', {
    ruleIds: ['plain', 'plain']
  });
  const nestedGroup = await postJson(port, '/api/mock-rules/combine', {
    ruleIds: ['plain', 'group']
  });

  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.body.error, /distinct/i);
  assert.equal(nestedGroup.statusCode, 400);
  assert.match(nestedGroup.body.error, /cannot contain other groups/i);
  assert.equal(writes, 0);
  assert.equal(proxy.mockRules, previousRules);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['plain', 'group']);
});

test('persistence failure restores the exact pre-combine in-memory tree', async t => {
  let writes = 0;
  let attemptedRules;
  const { proxy, port } = await createServer(t, {
    set: (_key, value) => {
      writes++;
      attemptedRules = JSON.parse(JSON.stringify(value));
      throw new Error('disk full');
    }
  });
  proxy.mockRules = [
    { id: 'first', enabled: true },
    { id: 'second', enabled: true },
    { id: 'untouched', enabled: true }
  ];
  const previousRules = proxy.mockRules;
  const previousSnapshot = JSON.parse(JSON.stringify(previousRules));

  const result = await postJson(port, '/api/mock-rules/combine', {
    ruleIds: ['first', 'second']
  });

  assert.equal(result.statusCode, 500);
  assert.match(result.body.error, /disk full/i);
  assert.equal(writes, 1);
  assert.equal(attemptedRules.at(-1).type, 'group');
  assert.deepEqual(attemptedRules.at(-1).items.map(rule => rule.id), ['first', 'second']);
  assert.equal(proxy.mockRules, previousRules);
  assert.deepEqual(proxy.mockRules, previousSnapshot);
  assert.equal(proxy.mockRules.some(rule => rule.type === 'group'), false);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const queueStart = rendererSource.indexOf('function _queueMockCollectionMutation');
const queueEnd = rendererSource.indexOf('function mockDrop', queueStart);
const combineStart = rendererSource.indexOf('function combineRulesAsGroup');
const combineEnd = rendererSource.indexOf('function mockDragEnd', combineStart);
assert.notEqual(queueStart, -1);
assert.notEqual(queueEnd, -1);
assert.notEqual(combineStart, -1);
assert.notEqual(combineEnd, -1);
const queueSource = rendererSource.slice(queueStart, queueEnd);
const combineSource = rendererSource.slice(combineStart, combineEnd);

function createRenderer(fetch) {
  const appliedRules = [];
  const toasts = [];
  let reloads = 0;
  let renders = 0;
  const context = {
    API_BASE: '',
    fetch,
    _replaceMockRulesFromServer: rules => appliedRules.push(JSON.parse(JSON.stringify(rules))),
    updateMockSaveButtons: () => {},
    loadMockRules: async () => { reloads++; },
    renderMockRules: () => { renders++; },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockReorderQueue = Promise.resolve();
    let mockResetInProgress = false;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockCollectionMutationCount = 0;
    ${queueSource}
    ${combineSource}
    this.combineRulesAsGroup = combineRulesAsGroup;
  `, context);
  return {
    context,
    appliedRules,
    toasts,
    get reloads() { return reloads; },
    get renders() { return renders; }
  };
}

test('renderer combines with one request and applies the complete server response', async () => {
  const requests = [];
  const rules = [{ id: 'group', type: 'group', items: [{ id: 'first' }, { id: 'second' }] }];
  const renderer = createRenderer(async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, group: rules[0], rules })
    };
  });

  await renderer.context.combineRulesAsGroup('first', 'second');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/mock-rules/combine');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    title: 'New Group',
    ruleIds: ['first', 'second']
  });
  assert.deepEqual(renderer.appliedRules, [rules]);
  assert.equal(renderer.reloads, 0);
  assert.equal(renderer.renders, 1);
  assert.deepEqual(renderer.toasts, [{
    message: 'Rules combined into a group (hold Shift + drop)',
    type: 'success'
  }]);
});

test('renderer reloads authoritative rules after stale-rule and persistence failures', async t => {
  for (const failure of [
    { status: 404, error: 'Rule not found' },
    { status: 500, error: 'disk full' }
  ]) {
    await t.test(String(failure.status), async () => {
      const requests = [];
      const renderer = createRenderer(async (url, options) => {
        requests.push({ url, options });
        return {
          ok: false,
          status: failure.status,
          json: async () => ({ error: failure.error })
        };
      });

      await renderer.context.combineRulesAsGroup('first', 'second');

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/api/mock-rules/combine');
      assert.equal(renderer.appliedRules.length, 0);
      assert.equal(renderer.renders, 0);
      assert.equal(renderer.reloads, 1);
      assert.deepEqual(renderer.toasts, [{
        message: `Error: ${failure.error}`,
        type: 'error'
      }]);
    });
  }
});

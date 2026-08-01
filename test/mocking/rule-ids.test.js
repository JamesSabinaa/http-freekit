import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload === null ? {} : {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    };
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.once('error', reject);
    request.end(payload || undefined);
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

const mockPayload = id => ({
  id,
  matchers: [{ type: 'wildcard' }],
  action: { type: 'fixed-response', status: 200 }
});

test('mock and breakpoint creation owns unique IDs and updates cannot mutate them', async t => {
  const { proxy, port } = await createServer(t);

  const firstMock = await requestJson(port, 'POST', '/api/mock-rules', mockPayload('duplicate'));
  const secondMock = await requestJson(port, 'POST', '/api/mock-rules', mockPayload('duplicate'));
  assert.equal(firstMock.statusCode, 200);
  assert.equal(secondMock.statusCode, 200);
  assert.notEqual(firstMock.body.rule.id, 'duplicate');
  assert.notEqual(secondMock.body.rule.id, 'duplicate');
  assert.notEqual(firstMock.body.rule.id, secondMock.body.rule.id);

  const mockUpdate = await requestJson(
    port,
    'PUT',
    `/api/mock-rules/${firstMock.body.rule.id}`,
    { id: 'mutated', enabled: false }
  );
  assert.equal(mockUpdate.statusCode, 200);
  assert.equal(mockUpdate.body.rule.id, firstMock.body.rule.id);
  assert.equal(proxy.mockRules[0].id, firstMock.body.rule.id);
  assert.equal(proxy.mockRules[0].enabled, false);

  const firstBreakpoint = await requestJson(port, 'POST', '/api/breakpoints', {
    id: 'duplicate',
    matchers: []
  });
  const secondBreakpoint = await requestJson(port, 'POST', '/api/breakpoints', {
    id: 'duplicate',
    matchers: []
  });
  assert.equal(firstBreakpoint.statusCode, 200);
  assert.equal(secondBreakpoint.statusCode, 200);
  assert.notEqual(firstBreakpoint.body.rule.id, 'duplicate');
  assert.notEqual(secondBreakpoint.body.rule.id, 'duplicate');
  assert.notEqual(firstBreakpoint.body.rule.id, secondBreakpoint.body.rule.id);

  const breakpointUpdate = await requestJson(
    port,
    'PATCH',
    `/api/breakpoints/${firstBreakpoint.body.rule.id}`,
    { id: 'mutated', enabled: false }
  );
  assert.equal(breakpointUpdate.statusCode, 200);
  assert.equal(breakpointUpdate.body.rule.id, firstBreakpoint.body.rule.id);
  assert.equal(proxy.breakpointRules[0].enabled, false);
});

test('mock imports and groups replace duplicate client IDs with server IDs', async t => {
  const { port } = await createServer(t);
  const imported = await requestJson(port, 'PUT', '/api/mock-rules', {
    rules: [mockPayload('duplicate'), mockPayload('duplicate')]
  });

  assert.equal(imported.statusCode, 200);
  assert.equal(new Set(imported.body.rules.map(rule => rule.id)).size, 2);
  assert.equal(imported.body.rules.some(rule => rule.id === 'duplicate'), false);

  const group = await requestJson(port, 'POST', '/api/mock-rules/group', {
    id: 'client-group',
    title: 'Group',
    items: [mockPayload('duplicate'), mockPayload('duplicate')]
  });
  const groupIds = [group.body.group.id, ...group.body.group.items.map(rule => rule.id)];

  assert.equal(group.statusCode, 200);
  assert.equal(new Set(groupIds).size, groupIds.length);
  assert.equal(groupIds.includes('client-group'), false);
  assert.equal(groupIds.includes('duplicate'), false);

  const [firstChildId] = group.body.group.items.map(rule => rule.id);
  const updatedGroup = await requestJson(
    port,
    'PUT',
    `/api/mock-rules/${group.body.group.id}`,
    {
      id: 'mutated-group',
      type: 'group',
      title: 'Updated Group',
      items: [
        { ...mockPayload(firstChildId), title: 'Known child' },
        { ...mockPayload('mutated-child'), title: 'Replacement child' },
        { ...mockPayload(firstChildId), title: 'Duplicate child ID' }
      ]
    }
  );
  const updatedIds = updatedGroup.body.rule.items.map(rule => rule.id);

  assert.equal(updatedGroup.statusCode, 200);
  assert.equal(updatedGroup.body.rule.id, group.body.group.id);
  assert.equal(updatedGroup.body.rule.title, 'Updated Group');
  assert.equal(updatedIds[0], firstChildId);
  assert.equal(updatedIds.includes('mutated-child'), false);
  assert.equal(new Set(updatedIds).size, updatedIds.length);
});

test('persisted mock IDs retain unique legacy values and repair numeric duplicates', () => {
  const proxy = new ProxyServer(null);
  const persistedRule = attributes => ({
    enabled: true,
    matchers: [],
    action: { type: 'fixed-response' },
    ...attributes
  });
  const restored = proxy.loadMockRules([
    persistedRule({ id: 'stable-id' }),
    persistedRule({ id: 1 }),
    persistedRule({ id: '1' }),
    persistedRule({})
  ]);
  const ids = proxy.mockRules.map(rule => rule.id);

  assert.equal(restored.migrated, true);
  assert.equal(ids[0], 'stable-id');
  assert.equal(ids[1], '1');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every(id => typeof id === 'string' && id.length > 0), true);
});

test('numeric mock deletion prefers an exact ID and retains legacy index fallback', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{ id: '1' }, { id: 'second' }];

  const byId = await requestJson(port, 'DELETE', '/api/mock-rules/1');
  assert.equal(byId.statusCode, 200);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['second']);

  proxy.mockRules = [{ id: 'first' }, { id: 'second' }];
  const byLegacyIndex = await requestJson(port, 'DELETE', '/api/mock-rules/1');
  assert.equal(byLegacyIndex.statusCode, 200);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['first']);

  proxy.mockRules = [{ id: 'first' }, { id: 'second' }];
  const nonCanonicalIndex = await requestJson(port, 'DELETE', '/api/mock-rules/01');
  assert.equal(nonCanonicalIndex.statusCode, 404);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['first', 'second']);
});

test('breakpoint deletion removes only one exact legacy duplicate', async t => {
  const { proxy, port } = await createServer(t);
  proxy.breakpointRules = [
    { id: 'legacy-duplicate', matchers: [] },
    { id: 'legacy-duplicate', matchers: [] }
  ];

  const deleted = await requestJson(port, 'DELETE', '/api/breakpoints/legacy-duplicate');
  assert.equal(deleted.statusCode, 200);
  assert.equal(proxy.breakpointRules.length, 1);

  const missing = await requestJson(port, 'DELETE', '/api/breakpoints/missing');
  assert.equal(missing.statusCode, 404);
  assert.equal(proxy.breakpointRules.length, 1);
});

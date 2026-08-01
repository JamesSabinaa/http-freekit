import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

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

test('moving a mock group into another group is rejected without mutation', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [
    { id: 'group-a', type: 'group', title: 'A', enabled: true, items: [] },
    { id: 'group-b', type: 'group', title: 'B', enabled: true, items: [] }
  ];

  const result = await postJson(port, '/api/mock-rules/move-to-group', {
    ruleId: 'group-a',
    groupId: 'group-b'
  });

  assert.equal(result.statusCode, 400);
  assert.match(result.body.error, /cannot contain other groups/);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['group-a', 'group-b']);
  assert.deepEqual(proxy.mockRules[1].items, []);
});

test('group creation rejects nested group payloads', async t => {
  const { proxy, port } = await createServer(t);
  const result = await postJson(port, '/api/mock-rules/group', {
    title: 'Outer',
    items: [{ id: 'inner', type: 'group', items: [] }]
  });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.mockRules, []);
});

test('legacy deeply nested rules remain editable and removable', () => {
  const proxy = new ProxyServer(null);
  const leaf = { id: 'leaf', enabled: true };
  proxy.mockRules = [{
    id: 'outer',
    type: 'group',
    items: [{ id: 'inner', type: 'group', items: [leaf] }]
  }];

  assert.equal(proxy.toggleMockRule('leaf').enabled, false);
  assert.equal(proxy.removeMockRuleById('leaf'), true);
  assert.equal(proxy._findMockRuleById('leaf'), null);
});

test('loading persisted rules flattens nested groups for the renderer', () => {
  const proxy = new ProxyServer(null);
  const mockRule = (id, enabled = true) => ({
    id,
    enabled,
    matchers: [],
    action: { type: 'fixed-response' }
  });
  const result = proxy.loadMockRules([{
    id: 'outer',
    type: 'group',
    enabled: true,
    items: [
      mockRule('first'),
      {
        id: 'inner',
        type: 'group',
        enabled: true,
        items: [
          mockRule('second'),
          {
            id: 'disabled-group',
            type: 'group',
            enabled: false,
            items: [mockRule('disabled-child')]
          }
        ]
      }
    ]
  }]);

  assert.equal(result.migrated, true);
  assert.deepEqual(result.rules[0].items.map(rule => rule.id), [
    'first', 'second', 'disabled-child'
  ]);
  assert.equal(result.rules[0].items.some(rule => rule.type === 'group'), false);
  assert.equal(result.rules[0].items[2].enabled, false);
});

test('startup delegates legacy group restoration to guarded migration persistence', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');
  assert.match(source, /restoreSavedRuleSettings\(proxy, settings\)/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { validateMockRule } from '../../src/proxy/mock-rule-validation.js';
import { Settings } from '../../src/settings.js';

const BINARY = Buffer.from([0, 255, 128, 1]);
const ORIGINAL = Buffer.from('original');
const KINDS = ['request', 'response', 'legacy-transform', 'fixed', 'legacy-fixed'];

function ruleFor(kind, body) {
  if (kind === 'legacy-fixed') {
    return { id: kind, enabled: true, method: 'POST', urlPattern: '/binary',
      response: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body } };
  }
  const action = kind === 'fixed'
    ? { type: 'fixed-response', status: 200, body }
    : kind === 'response'
      ? { type: 'transform-request', resBodyMode: 'replace-fixed', resBody: body }
      : { type: kind === 'request' ? 'transform-request' : 'transform-response', bodyMode: 'replace-fixed', body };
  return { id: kind, enabled: true, matchers: [{ type: 'wildcard' }], action };
}

function bodyOf(rule) {
  return rule.response?.body ?? (rule.action?.resBodyMode ? rule.action.resBody : rule.action.body);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function request(port, pathname, { method = 'POST', body = ORIGINAL, json = false } = {}) {
  const payload = json ? Buffer.from(JSON.stringify(body)) : body;
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-length': payload.length,
        'content-type': json ? 'application/json' : 'application/octet-stream' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createProxy(t) {
  const received = [];
  const origin = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({ body, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
  });
  return { proxy, received, send: body => request(proxy.server.address().port,
    `http://127.0.0.1:${originPort}/binary`, body === undefined ? {} : { body }) };
}

test('fixed binary rule bodies preserve exact request and response bytes across rule reloads', async t => {
  const { proxy, received, send } = await createProxy(t);
  for (const kind of KINDS) for (const representation of ['buffer', 'empty-buffer', 'string']) {
    for (const reload of ['none', 'memory', 'json']) {
      await t.test(`${kind}: ${representation}, ${reload}`, async () => {
        const body = representation === 'buffer' ? Buffer.from(BINARY)
          : representation === 'empty-buffer' ? Buffer.alloc(0) : 'héllo 世界';
        const expected = Buffer.from(body);
        proxy.mockRules = [];
        proxy.addMockRule(ruleFor(kind, body));
        if (reload === 'memory') proxy.loadMockRules(proxy.mockRules);
        if (reload === 'json') proxy.loadMockRules(JSON.parse(JSON.stringify(proxy.mockRules)));
        assert.equal(proxy.mockRules.length, 1);
        received.length = 0;
        const response = await send();
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, expected);
        if (kind.includes('fixed')) assert.equal(received.length, 0);
        else {
          assert.equal(received.length, 1);
          assert.deepEqual(received[0].body, kind === 'request' ? expected : ORIGINAL);
          assert.equal(Number(received[0].headers['content-length']),
            kind === 'request' ? expected.length : ORIGINAL.length);
        }
      });
    }
  }
});

test('binary rule cloning owns its bytes and preserves legacy and nested rule metadata', () => {
  const proxy = new ProxyServer(null);
  const input = ruleFor('fixed', Buffer.from(BINARY));
  const stored = proxy.addMockRule(input);
  input.action.body.fill(42);
  assert.deepEqual(stored.action.body, BINARY);
  const updates = { action: { type: 'fixed-response', body: BINARY.toJSON() } };
  proxy.updateMockRule(stored.id, updates);
  updates.action.body.data.fill(17);
  assert.deepEqual(stored.action.body, BINARY);

  const legacy = ruleFor('legacy-fixed', Buffer.from(BINARY));
  legacy.urlPattern = /\/binary/g;
  const nested = [{ id: 'group', type: 'group', enabled: true, items: [
    ruleFor('request', Buffer.from(BINARY)),
    { type: 'group', enabled: false, items: [legacy] }
  ] }];
  const before = JSON.stringify(nested);
  proxy.loadMockRules(nested);
  assert.equal(JSON.stringify(nested), before);
  assert.equal(proxy.mockRules[0].items.length, 2);
  assert.deepEqual(proxy.mockRules[0].items.map(bodyOf), [BINARY, BINARY]);
  assert.equal(proxy.mockRules[0].items[1].enabled, false);
  assert.ok(proxy.mockRules[0].items[1].urlPattern instanceof RegExp);
  proxy.mockRules[0].items[0].action.body.fill(99);
  assert.deepEqual(nested[0].items[0].action.body, BINARY);

  const fixed = Buffer.from(BINARY);
  const transformed = proxy._transformMockBody(ORIGINAL, 'replace-fixed', fixed);
  transformed.body.fill(11);
  assert.deepEqual(fixed, BINARY);
});

test('JSON rule saves, imports, disk restoration and failed-save rollback retain binary bodies', async t => {
  const { proxy, send } = await createProxy(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-binary-rules-'));
  const api = new ApiServer(proxy);
  api.settings = new Settings(directory);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.unlinkSync(api.settings.filePath);
    fs.rmdirSync(directory);
  });
  for (const kind of KINDS) {
    proxy.mockRules = [];
    const response = await request(port, '/api/mock-rules', { json: true, body: ruleFor(kind, BINARY) });
    assert.equal(response.status, 200, response.body.toString());
    const saved = JSON.parse(response.body).rule;
    assert.deepEqual(bodyOf(saved), BINARY.toJSON());
    assert.deepEqual((await send()).body, BINARY);
    const persisted = new Settings(directory).get('mockRules');
    assert.deepEqual(bodyOf(persisted[0]), BINARY.toJSON());
    const restored = new ProxyServer(null);
    restored.loadMockRules(persisted);
    assert.deepEqual(bodyOf(restored.mockRules[0]), BINARY);
    proxy.loadMockRules(restored.mockRules);
    assert.deepEqual((await send()).body, BINARY);

    const imported = await request(port, '/api/mock-rules', {
      method: 'PUT', json: true, body: { rules: [{ type: 'group', items: [saved] }] }
    });
    assert.equal(imported.status, 200, imported.body.toString());
    assert.deepEqual((await send()).body, BINARY);
    const beforeFile = fs.readFileSync(api.settings.filePath, 'utf8');
    const originalSave = api.settings._save;
    api.settings._save = () => { throw new Error('fixture persistence failed'); };
    const changedRule = proxy.mockRules[0].items[0];
    const failed = await request(port, `/api/mock-rules/${changedRule.id}`, {
      method: 'PUT', json: true, body: ruleFor(kind, 'changed')
    });
    api.settings._save = originalSave;
    assert.equal(failed.status, 500);
    assert.deepEqual(bodyOf(proxy.mockRules[0].items[0]), BINARY);
    assert.equal(fs.readFileSync(api.settings.filePath, 'utf8'), beforeFile);
    assert.deepEqual((await send()).body, BINARY);
  }
});

test('malformed serialized buffers remain invalid and atomic JSON imports reject them', async t => {
  const malformed = [
    {}, [], null, { type: 'Buffer' }, { data: [0] }, { type: 'buffer', data: [0] },
    { type: 'Buffer', data: '00ff80' }, { type: 'Buffer', data: { 0: 255, length: 1 } },
    { type: 'Buffer', data: [0], extra: true },
    ...[-1, 256, 1.5, '255', null, false, {}, NaN, Infinity].map(byte => ({ type: 'Buffer', data: [byte] })),
    { type: 'Buffer', data: new Array(1) }, new Uint8Array([0, 255, 128])
  ];
  const proxy = new ProxyServer(null);
  for (const kind of KINDS) for (const body of malformed) {
    const rule = ruleFor(kind, body);
    assert.match(validateMockRule(rule), /body must be a string or buffer/, `${kind}: ${JSON.stringify(body)}`);
    proxy.loadMockRules([ruleFor('fixed', 'kept'), { type: 'group', items: [rule] }]);
    assert.equal(proxy.mockRules[0].action.body, 'kept');
    assert.deepEqual(proxy.mockRules[1].items, []);
  }
  const api = new ApiServer(proxy);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const originalRules = proxy.mockRules;
  for (const kind of KINDS) {
    const response = await request(port, '/api/mock-rules', { method: 'PUT', json: true, body: {
      rules: [ruleFor('fixed', 'valid-prefix'), ruleFor(kind, { type: 'Buffer', data: [256] })]
    } });
    assert.equal(response.status, 400);
    assert.equal(proxy.mockRules, originalRules);
    assert.equal(proxy.mockRules[0].action.body, 'kept');
  }
});

test('Buffer JSON merge bodies retain their accepted behavior after a JSON rule round trip', async t => {
  const { proxy, received, send } = await createProxy(t);
  const rule = { enabled: true, matchers: [{ type: 'wildcard' }], action: {
    type: 'transform-request', bodyMode: 'json-merge', body: Buffer.from('{"request":true}'),
    resBodyMode: 'json-merge', resBody: Buffer.from('{"response":true}')
  } };
  const persisted = JSON.parse(JSON.stringify(rule));
  assert.equal(validateMockRule(persisted), null);
  proxy.loadMockRules([persisted]);
  const response = await send(Buffer.from('{"original":true}'));
  assert.deepEqual(JSON.parse(received[0].body), { original: true, request: true });
  assert.deepEqual(JSON.parse(response.body), { original: true, request: true, response: true });
  for (const invalid of ['[]', 'null', 'invalid']) {
    const malformed = structuredClone(persisted);
    malformed.action.body = Buffer.from(invalid).toJSON();
    assert.match(validateMockRule(malformed), /JSON/);
  }
});

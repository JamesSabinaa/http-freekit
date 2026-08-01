import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

function mockRule(id, title = id) {
  return {
    id,
    title,
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  };
}

function putJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/mock-rules',
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
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: response.statusCode, body: parsed, text });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-349-'));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { proxy, settings, port: server.address().port };
}

function savedSettings(settings) {
  return JSON.parse(fs.readFileSync(settings.filePath, 'utf8'));
}

test('valid flat append commits the complete batch in one persistence write', async t => {
  const { proxy, settings, port } = await createServer(t);
  const existing = mockRule('existing', 'Existing');
  proxy.loadMockRules([existing]);
  settings.setAll({ mockRules: proxy.mockRules });

  const originalSetAll = settings.setAll.bind(settings);
  let writes = 0;
  settings.setAll = values => {
    writes += 1;
    return originalSetAll(values);
  };
  const imported = [mockRule('first', 'First'), mockRule('second', 'Second')];

  const result = await putJson(port, { mode: 'append', rules: imported });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(writes, 1);
  assert.deepEqual(proxy.mockRules.map(rule => rule.title), ['Existing', 'First', 'Second']);
  assert.deepEqual(settings.get('mockRules'), proxy.mockRules);
  assert.deepEqual(savedSettings(settings).mockRules, proxy.mockRules);
});

test('invalid append retries never commit or duplicate the valid prefix', async t => {
  const { proxy, settings, port } = await createServer(t);
  const existing = mockRule('existing', 'Existing');
  proxy.loadMockRules([existing]);
  settings.setAll({ mockRules: proxy.mockRules });
  const originalReference = proxy.mockRules;
  const beforeFile = savedSettings(settings);
  const originalSetAll = settings.setAll.bind(settings);
  let writes = 0;
  settings.setAll = values => {
    writes += 1;
    return originalSetAll(values);
  };
  const batch = { mode: 'append', rules: [mockRule('valid-prefix', 'Valid Prefix'), {}] };

  const first = await putJson(port, batch);
  const retry = await putJson(port, batch);

  assert.equal(first.statusCode, 400);
  assert.equal(retry.statusCode, 400);
  assert.equal(writes, 0);
  assert.equal(proxy.mockRules, originalReference);
  assert.deepEqual(proxy.mockRules, [existing]);
  assert.equal(proxy.mockRules.some(rule => rule.title === 'Valid Prefix'), false);
  assert.deepEqual(settings.get('mockRules'), beforeFile.mockRules);
  assert.deepEqual(savedSettings(settings), beforeFile);
});

test('append persistence failure restores the exact runtime tree and settings file', async t => {
  t.mock.method(console, 'error', () => {});
  const { proxy, settings, port } = await createServer(t);
  const existing = mockRule('existing', 'Existing');
  proxy.loadMockRules([existing]);
  settings.setAll({ mockRules: proxy.mockRules });
  const originalReference = proxy.mockRules;
  const beforeSettings = settings.getAll();
  const beforeFile = savedSettings(settings);
  settings._save = () => { throw new Error('disk full'); };

  const result = await putJson(port, {
    mode: 'append',
    rules: [mockRule('imported', 'Imported')]
  });

  assert.equal(result.statusCode, 500);
  assert.equal(proxy.mockRules, originalReference);
  assert.deepEqual(proxy.mockRules, [existing]);
  assert.deepEqual(settings.getAll(), beforeSettings);
  assert.deepEqual(savedSettings(settings), beforeFile);
});

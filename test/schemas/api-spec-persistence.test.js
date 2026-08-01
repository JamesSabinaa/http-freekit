import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';
import { restoreSavedApiSpecs } from '../../src/startup-api-spec-restoration.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      } : undefined
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload || undefined);
  });
}

async function startApi(proxy, settings) {
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    api,
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Persistent API' },
  paths: {
    '/widgets/{id}': {
      get: { operationId: 'getWidget', summary: 'Get a widget' }
    }
  }
};

test('API spec uploads and deletions survive complete server restarts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-api-specs-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const firstSettings = new Settings(dataDir);
  const firstProxy = new ProxyServer(null);
  const firstServer = await startApi(firstProxy, firstSettings);
  const created = await requestJson(firstServer.port, 'POST', '/api/specs', {
    title: 'Persistent API',
    baseUrl: ' https://api.example.test/v1 ',
    spec: openApiDocument
  });
  assert.equal(created.statusCode, 200);
  const id = created.body.spec.id;
  assert.equal(typeof id, 'string');

  const saved = new Settings(dataDir).get('apiSpecs');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, id);
  assert.equal(saved[0].baseUrl, 'https://api.example.test/v1');
  assert.deepEqual(saved[0].spec, openApiDocument);
  await firstServer.close();

  const restartedSettings = new Settings(dataDir);
  const restartedProxy = new ProxyServer(null);
  const restored = restoreSavedApiSpecs(restartedProxy, restartedSettings);
  assert.equal(restored.migrated, false);
  const restartedServer = await startApi(restartedProxy, restartedSettings);
  const listed = await requestJson(restartedServer.port, 'GET', '/api/specs');
  assert.deepEqual(listed, {
    statusCode: 200,
    body: { specs: [{ id, title: 'Persistent API', baseUrl: 'https://api.example.test/v1' }] }
  });
  assert.equal(
    restartedProxy.matchApiSpec('GET', '/widgets/42', 'api.example.test').operationId,
    'getWidget'
  );

  const removed = await requestJson(
    restartedServer.port,
    'DELETE',
    `/api/specs/${encodeURIComponent(id)}`
  );
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(new Settings(dataDir).get('apiSpecs'), []);
  await restartedServer.close();

  const finalProxy = new ProxyServer(null);
  const finalRestore = restoreSavedApiSpecs(finalProxy, new Settings(dataDir));
  assert.deepEqual(finalRestore.specs, []);
});

test('startup discards malformed specs and repairs non-canonical identities', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-api-spec-migrate-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  settings.set('apiSpecs', [
    { id: 'stable-id', title: 'One', baseUrl: '', spec: { paths: {} } },
    { id: 'stable-id', title: 'Two', baseUrl: ' api.example.test ', spec: { paths: {} } },
    { id: 'invalid', title: 'Invalid', baseUrl: {}, spec: { paths: {} } },
    null
  ]);

  const proxy = new ProxyServer(null);
  const restored = restoreSavedApiSpecs(proxy, settings, { log() {}, warn() {} });
  assert.equal(restored.discarded, 2);
  assert.equal(restored.migrated, true);
  assert.equal(restored.specs.length, 2);
  assert.equal(restored.specs[0].id, 'stable-id');
  assert.notEqual(restored.specs[1].id, 'stable-id');
  assert.equal(restored.specs[1].baseUrl, 'api.example.test');
  assert.deepEqual(new Settings(dataDir).get('apiSpecs'), restored.specs);
  proxy.addApiSpec({ title: 'Runtime only', baseUrl: '', spec: { paths: {} } });
  assert.equal(settings.get('apiSpecs').length, 2, 'settings must not share the live array');

  const cleanSettings = new Settings(dataDir);
  const cleanProxy = new ProxyServer(null);
  const cleanRestart = restoreSavedApiSpecs(cleanProxy, cleanSettings, {
    log() {}, warn() {}
  });
  assert.equal(cleanRestart.migrated, false);
  assert.equal(cleanRestart.discarded, 0);
  assert.notEqual(cleanProxy.apiSpecs[0].spec, cleanSettings.get('apiSpecs')[0].spec);
  cleanProxy.apiSpecs[0].spec.paths['/runtime-only'] = { get: {} };
  assert.equal(cleanSettings.get('apiSpecs')[0].spec.paths['/runtime-only'], undefined);
});

test('persistence failures roll live API spec mutations back', async t => {
  const proxy = new ProxyServer(null);
  proxy.addApiSpec({
    id: 'existing-id',
    title: 'Existing',
    baseUrl: '',
    spec: { paths: {} }
  });
  const settings = { setAll() { throw new Error('settings disk full'); } };
  const server = await startApi(proxy, settings);
  t.after(() => server.close());

  const failedCreate = await requestJson(server.port, 'POST', '/api/specs', {
    title: 'New',
    baseUrl: '',
    spec: { paths: {} }
  });
  assert.equal(failedCreate.statusCode, 500);
  assert.match(failedCreate.body.error, /settings disk full/);
  assert.deepEqual(proxy.getApiSpecs().map(spec => spec.id), ['existing-id']);

  const failedDelete = await requestJson(server.port, 'DELETE', '/api/specs/existing-id');
  assert.equal(failedDelete.statusCode, 500);
  assert.match(failedDelete.body.error, /settings disk full/);
  assert.deepEqual(proxy.getApiSpecs().map(spec => spec.id), ['existing-id']);
});

test('a failed startup repair write keeps validated specs live and warns', () => {
  const warnings = [];
  const proxy = new ProxyServer(null);
  const restored = restoreSavedApiSpecs(proxy, {
    get: () => [{ title: 'Recovered', baseUrl: '', spec: { paths: {} } }],
    set: () => { throw new Error('read-only settings'); }
  }, {
    log() {},
    warn: message => warnings.push(message)
  });

  assert.equal(restored.specs.length, 1);
  assert.equal(typeof restored.specs[0].id, 'string');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /read-only settings/);
});

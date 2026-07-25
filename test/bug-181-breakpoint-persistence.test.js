import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { Settings } from '../src/settings.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload === null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
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
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('breakpoint API mutations persist across a server restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-breakpoints-'));
  const openServers = new Set();
  t.after(async () => {
    await Promise.all([...openServers].map(server => server.close()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const settings = new Settings(dataDir);
  const firstProxy = new ProxyServer(null);
  const firstServer = await startApi(firstProxy, settings);
  openServers.add(firstServer);

  const invalidCreate = await requestJson(firstServer.port, 'POST', '/api/breakpoints', {
    matchers: {}
  });
  assert.equal(invalidCreate.statusCode, 400);
  assert.equal(settings.get('breakpointRules'), undefined);

  const created = await requestJson(firstServer.port, 'POST', '/api/breakpoints', {
    matchers: [{ type: 'method', value: 'GET' }]
  });
  const breakpointId = created.body.rule.id;
  assert.equal(created.statusCode, 200);
  assert.deepEqual(settings.get('breakpointRules').map(rule => rule.id), [breakpointId]);

  const updated = await requestJson(
    firstServer.port,
    'PATCH',
    `/api/breakpoints/${breakpointId}`,
    { enabled: false }
  );
  assert.equal(updated.statusCode, 200);
  assert.equal(settings.get('breakpointRules')[0].enabled, false);

  await firstServer.close();
  openServers.delete(firstServer);

  const restartedSettings = new Settings(dataDir);
  const restartedProxy = new ProxyServer(null);
  const restored = restartedProxy.loadBreakpoints(restartedSettings.get('breakpointRules'));
  const restartedServer = await startApi(restartedProxy, restartedSettings);
  openServers.add(restartedServer);

  assert.equal(restored.migrated, false);
  const afterRestart = await requestJson(restartedServer.port, 'GET', '/api/breakpoints');
  assert.equal(afterRestart.statusCode, 200);
  assert.equal(afterRestart.body.rules.length, 1);
  assert.equal(afterRestart.body.rules[0].id, breakpointId);
  assert.equal(afterRestart.body.rules[0].enabled, false);

  const deleted = await requestJson(
    restartedServer.port,
    'DELETE',
    `/api/breakpoints/${breakpointId}`
  );
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(new Settings(dataDir).get('breakpointRules'), []);
});

test('stored breakpoints discard malformed rules and repair unsafe identities', () => {
  const proxy = new ProxyServer(null);
  const restored = proxy.loadBreakpoints([
    { id: 'stable-id', enabled: true, matchers: [] },
    { id: 'stable-id', enabled: false, matchers: [] },
    { id: 7, enabled: true, matchers: [] },
    { matchers: [] },
    { id: 'bad-matchers', matchers: {} },
    { id: 'bad-enabled', enabled: 'yes', matchers: [] },
    null
  ]);
  const ids = restored.rules.map(rule => rule.id);

  assert.equal(restored.migrated, true);
  assert.equal(restored.discarded, 3);
  assert.equal(restored.rules.length, 4);
  assert.equal(ids[0], 'stable-id');
  assert.equal(ids[2], '7');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every(id => typeof id === 'string' && id.length > 0), true);
  assert.equal(restored.rules[3].enabled, true);

  assert.doesNotThrow(() => proxy.loadBreakpoints({ rules: [] }));
  assert.deepEqual(proxy.getBreakpoints(), []);
});

test('startup restores and writes back migrated breakpoint settings', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(path.join(process.cwd(), 'src', 'index.js'), 'utf8');

  assert.match(source, /settings\.get\('breakpointRules'\)/);
  assert.match(source, /proxy\.loadBreakpoints\(savedBreakpointRules\)/);
  assert.match(source, /if \(restored\.migrated\) settings\.set\('breakpointRules', restored\.rules\)/);
});

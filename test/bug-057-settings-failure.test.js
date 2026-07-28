import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiServer } from '../src/api/api-server.js';
import { Settings } from '../src/settings.js';

function postJson(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('failed settings writes throw and restore the previous in-memory values', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-failure-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  settings.set('mode', 'saved');
  settings.filePath = dataDir;

  assert.throws(() => settings.set('mode', 'unsaved'));
  assert.equal(settings.get('mode'), 'saved');
  assert.throws(() => settings.setAll({ mode: 'also-unsaved', extra: true }));
  assert.deepEqual(settings.getAll(), { mode: 'saved' });
});

test('settings API does not report success when persistence fails', async (t) => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = {
    get: (_key, fallback) => fallback,
    set: () => { throw new Error('disk full'); }
  };
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const statusCode = await postJson(server.address().port, '/api/ui-settings', {
    hideTunnelRequests: false,
    filterSafeFonts: false
  });

  assert.equal(statusCode, 500);
});

test('renderer turns management API failures into errors before showing success', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

  assert.match(source, /if \(isManagementApi && !response\.ok\)/);
  assert.match(source, /new Error\(payload\.error \|\| `Management API returned HTTP \$\{response\.status\}`\)/);
  assert.match(source, /error\.status = response\.status/);
});

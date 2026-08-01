import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiServer } from '../../src/api/api-server.js';
import { resolveProxyPortRange } from '../../src/proxy/port-range.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

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
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('port range API persists a validated range for startup', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-port-range-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  const proxy = {
    port: 8081,
    minPort: 8081,
    maxPort: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  const apiPort = await listen(server);
  t.after(() => close(server));

  const response = await postJson(apiPort, '/api/port-config', { minPort: 19000, maxPort: 19010 });

  assert.equal(response.statusCode, 200, response.body);
  const reloaded = new Settings(dataDir);
  assert.deepEqual(resolveProxyPortRange(reloaded), { minPort: 19000, maxPort: 19010 });
  assert.deepEqual(resolveProxyPortRange(reloaded, '20000'), { minPort: 20000, maxPort: 20000 });
});

test('proxy startup advances to the first available port in its configured range', async (t) => {
  const blocker = http.createServer();
  let blockedPort = await listen(blocker, 0, '127.0.0.1');
  while (blockedPort > 65525) {
    await close(blocker);
    blockedPort = await listen(blocker, 0, '127.0.0.1');
  }
  t.after(() => close(blocker));

  const proxy = new ProxyServer(null, {
    port: blockedPort,
    minPort: blockedPort,
    maxPort: blockedPort + 10
  });
  await proxy.start();
  t.after(() => proxy.stop());

  assert.ok(proxy.port > blockedPort);
  assert.ok(proxy.port <= blockedPort + 10);
});

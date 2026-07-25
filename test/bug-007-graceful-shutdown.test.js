import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiServer } from '../src/api/api-server.js';

function post(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.once('error', reject);
    req.end('{}');
  });
}

test('shutdown API delegates to the configured graceful shutdown handler', async (t) => {
  let resolveShutdown;
  const shutdownCalled = new Promise(resolve => { resolveShutdown = resolve; });
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, {
    onShutdown: async () => resolveShutdown()
  });
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await post(server.address().port, '/api/shutdown');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true });
  await shutdownCalled;
});

test('application wires the API shutdown route to the centralized cleanup path', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.js'), 'utf8');

  assert.match(source, /api\.setShutdownHandler\(shutdown\)/);
  assert.match(
    source,
    /await mcpBridge\.stop\(\);[\s\S]*?await interceptors\.deactivateAll\(\);[\s\S]*?await proxy\.stop\(\);[\s\S]*?await api\.stop\(\)/
  );
});

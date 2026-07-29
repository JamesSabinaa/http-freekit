import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { ApiServer } from '../src/api/api-server.js';
import {
  MCP_ENABLED_SETTING,
  resolveMcpEnabled
} from '../src/mcp/enabled-state.js';
import { McpServerBridge } from '../src/mcp/mcp-server.js';
import { Settings } from '../src/settings.js';

function listen(server) {
  server.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload === null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
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
    request.end(payload);
  });
}

function createProxy() {
  return {
    port: 8081,
    mockRules: [],
    breakpointRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    getStats: () => ({}),
    matchApiSpec: () => null
  };
}

function createBridge(initialEnabled, { beforeSet } = {}) {
  let enabled = initialEnabled;
  const setCalls = [];
  let startSseCalls = 0;
  return {
    async setEnabled(nextEnabled) {
      setCalls.push(nextEnabled);
      await beforeSet?.(nextEnabled, setCalls.length);
      enabled = nextEnabled;
    },
    startSse() { startSseCalls++; },
    getStatus() {
      return {
        enabled,
        connectedClients: 0,
        sseEndpoint: enabled ? '/mcp/sse' : null
      };
    },
    setCalls,
    get startSseCalls() { return startSseCalls; }
  };
}

async function createApiHarness(t, { bridge, settings }) {
  const api = new ApiServer(createProxy(), null, null);
  api.settings = settings;
  api.setMcpBridge(bridge);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  return { api, port };
}

test('MCP defaults enabled and restores only an explicit persisted false', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-mcp-enabled-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);

  assert.equal(resolveMcpEnabled(settings), true);
  settings.set(MCP_ENABLED_SETTING, false);
  assert.equal(resolveMcpEnabled(new Settings(dataDir)), false);
  settings.set(MCP_ENABLED_SETTING, true);
  assert.equal(resolveMcpEnabled(new Settings(dataDir)), true);
  settings.set(MCP_ENABLED_SETTING, 'false');
  assert.equal(resolveMcpEnabled(new Settings(dataDir)), true);
});

test('MCP toggle persists disabled and re-enabled state for the next startup', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-mcp-toggle-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  const bridge = createBridge(true);
  const { port } = await createApiHarness(t, { bridge, settings });

  const disabled = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: false });
  assert.deepEqual(disabled, {
    statusCode: 200,
    body: { success: true, enabled: false }
  });
  const afterDisable = new Settings(dataDir);
  assert.equal(afterDisable.get(MCP_ENABLED_SETTING), false);
  assert.equal(resolveMcpEnabled(afterDisable), false);
  assert.equal(bridge.getStatus().enabled, false);

  const enabled = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: true });
  assert.deepEqual(enabled, {
    statusCode: 200,
    body: { success: true, enabled: true }
  });
  const afterEnable = new Settings(dataDir);
  assert.equal(afterEnable.get(MCP_ENABLED_SETTING), true);
  assert.equal(resolveMcpEnabled(afterEnable), true);
  assert.equal(bridge.getStatus().enabled, true);
  assert.equal(bridge.startSseCalls, 1);
});

test('a failed MCP settings write rolls the live bridge back before reporting failure', async (t) => {
  const bridge = createBridge(true);
  const settings = {
    setAll() { throw new Error('disk full'); }
  };
  const { port } = await createApiHarness(t, { bridge, settings });

  const response = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: false });

  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /disk full/);
  assert.equal(bridge.getStatus().enabled, true);
  assert.deepEqual(bridge.setCalls, [false, true]);
  assert.equal(bridge.startSseCalls, 1);
});

test('MCP toggle rejects non-booleans without changing runtime or settings', async (t) => {
  const bridge = createBridge(true);
  const writes = [];
  const { port } = await createApiHarness(t, {
    bridge,
    settings: { setAll: values => writes.push(values) }
  });

  const response = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: 'false' });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /boolean/);
  assert.equal(bridge.getStatus().enabled, true);
  assert.deepEqual(bridge.setCalls, []);
  assert.deepEqual(writes, []);
});

test('concurrent MCP toggles serialize runtime and persisted state in request order', async (t) => {
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; });
  const bridge = createBridge(true, {
    beforeSet: async (enabled, callNumber) => {
      if (callNumber !== 1) return;
      assert.equal(enabled, false);
      firstStarted();
      await new Promise(resolve => { releaseFirst = resolve; });
    }
  });
  const writes = [];
  const { port } = await createApiHarness(t, {
    bridge,
    settings: { setAll: values => writes.push(structuredClone(values)) }
  });

  const disable = requestJson(port, 'POST', '/api/mcp/toggle', { enabled: false });
  await firstStartedPromise;
  const enable = requestJson(port, 'POST', '/api/mcp/toggle', { enabled: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bridge.setCalls, [false]);
  releaseFirst();

  const [disabledResponse, enabledResponse] = await Promise.all([disable, enable]);
  assert.equal(disabledResponse.body.enabled, false);
  assert.equal(enabledResponse.body.enabled, true);
  assert.deepEqual(writes, [
    { [MCP_ENABLED_SETTING]: false },
    { [MCP_ENABLED_SETTING]: true }
  ]);
  assert.equal(bridge.getStatus().enabled, true);
});

test('a startup-disabled MCP bridge registers routes that report it disabled', async (t) => {
  const bridge = new McpServerBridge({
    apiServer: {
      trafficLog: [],
      _broadcast() {},
      _isAllowedBrowserOrigin: () => true,
      _isAuthorizedRequest: () => true
    },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] },
    options: { enabled: false }
  });
  const app = express();
  bridge.startSse(app);
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(async () => {
    await bridge.stop();
    await close(server);
  });

  const response = await requestJson(port, 'GET', '/mcp/sse');

  assert.equal(bridge.server, null);
  assert.equal(bridge.sseRoutesRegistered, true);
  assert.deepEqual(response, {
    statusCode: 503,
    body: { error: 'MCP server is disabled' }
  });
});

test('application startup feeds the restored MCP setting into the bridge', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');

  assert.match(source, /const mcpEnabled = resolveMcpEnabled\(settings\)/);
  assert.match(source, /options:\s*\{\s*enabled: mcpEnabled,/);
  assert.doesNotMatch(source, /options:\s*\{\s*enabled: true,/);
});

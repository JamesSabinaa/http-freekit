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

function createBridge(initialEnabled, { beforeSet, shouldApply = () => true } = {}) {
  let enabled = initialEnabled;
  const setCalls = [];
  let startSseCalls = 0;
  return {
    async setEnabled(nextEnabled) {
      setCalls.push(nextEnabled);
      await beforeSet?.(nextEnabled, setCalls.length);
      if (shouldApply(nextEnabled, setCalls.length)) enabled = nextEnabled;
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

test('a failed runtime rollback exposes divergence until a later toggle reconciles it', async (t) => {
  const bridge = createBridge(true, {
    beforeSet: async (_enabled, callNumber) => {
      if (callNumber === 2) throw new Error('enable rollback failed');
    }
  });
  let writeCalls = 0;
  const writes = [];
  const settings = {
    setAll(values) {
      writeCalls++;
      if (writeCalls === 1) throw new Error('disk temporarily unavailable');
      writes.push(structuredClone(values));
    }
  };
  const { port } = await createApiHarness(t, { bridge, settings });

  const failed = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: false });

  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.degraded, true);
  assert.equal(failed.body.enabled, false);
  assert.equal(failed.body.persistedEnabled, true);
  assert.match(failed.body.degradedReason, /enabled=false.*enabled=true/);
  assert.deepEqual(bridge.setCalls, [false, true]);

  const degradedStatus = await requestJson(port, 'GET', '/api/mcp/status');
  assert.equal(degradedStatus.body.degraded, true);
  assert.equal(degradedStatus.body.enabled, false);
  assert.equal(degradedStatus.body.persistedEnabled, true);

  const reconciled = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: false });
  assert.deepEqual(reconciled, {
    statusCode: 200,
    body: { success: true, enabled: false }
  });
  assert.deepEqual(writes, [{ [MCP_ENABLED_SETTING]: false }]);
  const reconciledStatus = await requestJson(port, 'GET', '/api/mcp/status');
  assert.notEqual(reconciledStatus.body.degraded, true);
  assert.equal(Object.hasOwn(reconciledStatus.body, 'persistedEnabled'), false);
});

test('an ineffective MCP rollback is detected even when it resolves', async (t) => {
  const bridge = createBridge(true, {
    shouldApply: (_enabled, callNumber) => callNumber !== 2
  });
  const { port } = await createApiHarness(t, {
    bridge,
    settings: { setAll() { throw new Error('read-only settings'); } }
  });

  const response = await requestJson(port, 'POST', '/api/mcp/toggle', { enabled: false });

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.degraded, true);
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.persistedEnabled, true);
  assert.match(response.body.error, /rollback failed/i);
});

test('failed MCP transport cleanup is reported and retained for a successful retry', async () => {
  const bridge = new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  const ownedServer = bridge.server;
  let serverCloseCalls = 0;
  let transportCloseCalls = 0;
  let closeShouldFail = true;
  bridge.stdioTransport = {
    async close() { transportCloseCalls++; }
  };
  ownedServer.close = async () => {
    serverCloseCalls++;
    if (closeShouldFail) throw new Error('stdio server close failed');
  };

  await assert.rejects(
    bridge.setEnabled(false),
    error => error instanceof AggregateError && /fully stop/.test(error.message)
  );
  assert.equal(bridge.server, null);
  assert.deepEqual(bridge.getStatus(), {
    enabled: true,
    sseEndpoint: null,
    connectedClients: 0,
    stdioActive: true,
    degraded: true,
    degradedReason: 'Could not close MCP stdio transport: stdio server close failed',
    pendingCleanupCount: 1,
    claudeDesktopConfig: null
  });

  closeShouldFail = false;
  await bridge.setEnabled(false);
  assert.equal(serverCloseCalls, 2);
  assert.equal(transportCloseCalls, 1);
  assert.equal(bridge.getStatus().enabled, false);
  assert.equal(bridge.getStatus().degraded, false);
  assert.equal(bridge.getStatus().pendingCleanupCount, 0);
});

test('best-effort shutdown retries cleanup after an overlapping strict stop fails', async () => {
  const bridge = new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  const ownedServer = bridge.server;
  let closeCalls = 0;
  let releaseFirstClose;
  let markFirstCloseStarted;
  const firstCloseStarted = new Promise(resolve => { markFirstCloseStarted = resolve; });
  const firstCloseBlocked = new Promise(resolve => { releaseFirstClose = resolve; });
  ownedServer.close = async () => {
    closeCalls++;
    if (closeCalls !== 1) return;
    markFirstCloseStarted();
    await firstCloseBlocked;
    throw new Error('strict cleanup failed');
  };

  const strictStop = bridge.stop();
  const strictRejection = assert.rejects(strictStop, /fully stop/);
  await firstCloseStarted;
  const shutdownStop = bridge.stop({ bestEffort: true });
  assert.notEqual(shutdownStop, strictStop);
  releaseFirstClose();

  await strictRejection;
  await shutdownStop;
  assert.equal(closeCalls, 2);
  assert.equal(bridge.getStatus().enabled, false);
  assert.equal(bridge.getStatus().degraded, false);
  assert.equal(bridge.getStatus().pendingCleanupCount, 0);
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
  assert.match(source, /mcpBridge\.stop\(\{ bestEffort: true \}\)/);
});

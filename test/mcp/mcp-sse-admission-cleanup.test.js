import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../../src/mcp/mcp-server.js';

function createBridge() {
  return new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
}

function registerRoutes(bridge) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }
  };
  bridge.startSse(app);
  return routes;
}

function createResponse() {
  return {
    writableEnded: false,
    destroyed: false,
    endCalls: 0,
    destroyCalls: 0,
    end() {
      this.endCalls++;
      this.writableEnded = true;
    },
    destroy() {
      this.destroyCalls++;
      this.destroyed = true;
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for SSE admission cleanup');
}

test('failed SSE admission closes its server, transport, and HTTP response', async t => {
  const bridge = createBridge();
  t.after(() => bridge.stop({ bestEffort: true }));
  let serverCloseCalls = 0;
  const sessionServer = {
    connect() { return Promise.reject(new Error('SSE start refused')); },
    async close() { serverCloseCalls++; }
  };
  bridge._buildServer = () => sessionServer;
  const routes = registerRoutes(bridge);
  const response = createResponse();

  routes.get('GET /mcp/sse').at(-1)({ url: '/mcp/sse', headers: {} }, response);
  const [session] = bridge.sseSessions.values();
  let transportCloseCalls = 0;
  session.transport.close = async () => { transportCloseCalls++; };

  await waitFor(() => bridge.sseSessions.size === 0 && response.writableEnded);
  assert.equal(transportCloseCalls, 1);
  assert.equal(serverCloseCalls, 1);
  assert.equal(response.endCalls, 1);
  assert.equal(bridge.getStatus().degraded, false);
  assert.equal(bridge.getStatus().connectedClients, 0);
});

test('failed SSE admission cleanup remains owned until Stop can retry it', async t => {
  const bridge = createBridge();
  t.after(() => bridge.stop({ bestEffort: true }));
  let cleanupShouldFail = true;
  let serverCloseCalls = 0;
  const sessionServer = {
    connect() { return Promise.reject(new Error('SSE start refused')); },
    async close() {
      serverCloseCalls++;
      if (cleanupShouldFail) throw new Error('session server close failed');
    }
  };
  bridge._buildServer = () => sessionServer;
  const routes = registerRoutes(bridge);
  const response = createResponse();
  response.end = () => { throw new Error('response end failed'); };

  routes.get('GET /mcp/sse').at(-1)({ url: '/mcp/sse', headers: {} }, response);
  const [session] = bridge.sseSessions.values();
  let transportCloseCalls = 0;
  session.transport.close = async () => {
    transportCloseCalls++;
    if (cleanupShouldFail) throw new Error('transport close failed');
  };

  await waitFor(() => bridge.getStatus().pendingCleanupCount === 1);
  assert.equal(bridge.sseSessions.size, 0);
  assert.equal(response.destroyCalls, 1);
  assert.equal(bridge.getStatus().connectedClients, 1);
  assert.equal(bridge.getStatus().degraded, true);
  assert.match(bridge.getStatus().degradedReason, /transport close failed/);
  assert.match(bridge.getStatus().degradedReason, /session server close failed/);

  cleanupShouldFail = false;
  await bridge.stop({ bestEffort: true });
  assert.equal(transportCloseCalls, 2);
  assert.equal(serverCloseCalls, 2);
  assert.equal(bridge.getStatus().pendingCleanupCount, 0);
  assert.equal(bridge.getStatus().connectedClients, 0);
  assert.equal(bridge.getStatus().degraded, false);
});

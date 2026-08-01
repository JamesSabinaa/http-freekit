import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../../src/mcp/mcp-server.js';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('an enable waits for an overlapping MCP disable to finish closing sessions', async t => {
  const bridge = new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  t.after(() => bridge.stop({ bestEffort: true }));
  const initialServer = bridge.server;
  const closeStarted = deferred();
  const releaseClose = deferred();
  bridge.sseSessions.set('held-session', {
    transport: {
      async close() {
        closeStarted.resolve();
        await releaseClose.promise;
      }
    },
    server: { async close() {} }
  });

  const disable = bridge.setEnabled(false);
  await closeStarted.promise;
  let enableSettled = false;
  const enable = bridge.setEnabled(true).then(() => { enableSettled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(enableSettled, false);
  assert.equal(bridge.server, null);
  assert.equal(bridge.getStatus().enabled, false);

  releaseClose.resolve();
  await Promise.all([disable, enable]);

  assert.equal(enableSettled, true);
  assert.equal(bridge.getStatus().enabled, true);
  assert.notEqual(bridge.server, null);
  assert.notEqual(bridge.server, initialServer);
  assert.equal(bridge.getStatus().degraded, false);
});

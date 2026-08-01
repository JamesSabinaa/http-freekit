import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { McpServerBridge } from '../../src/mcp/mcp-server.js';

function createBridge(enabled = true) {
  return new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] },
    options: { enabled }
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

async function readJsonLine(stream) {
  const [chunk] = await once(stream, 'data');
  return JSON.parse(chunk.toString('utf8').trim());
}

test('re-enabling MCP restores the configured stdio transport', async t => {
  const bridge = createBridge();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const onFatalError = () => {};
  t.after(async () => {
    await bridge.stop({ bestEffort: true });
    stdin.destroy();
    stdout.destroy();
  });

  await bridge.startStdio({ stdin, stdout, onFatalError });
  const initialTransport = bridge.stdioTransport;
  assert.equal(bridge.getStatus().stdioActive, true);
  assert.equal(stdin.listenerCount('data'), 1);

  await bridge.setEnabled(false);
  assert.equal(bridge.getStatus().enabled, false);
  assert.equal(bridge.getStatus().stdioActive, false);
  assert.equal(bridge.server, null);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.writableEnded, false);

  await bridge.setEnabled(true);
  assert.equal(bridge.getStatus().enabled, true);
  assert.equal(bridge.getStatus().stdioActive, true);
  assert.notEqual(bridge.stdioTransport, initialTransport);
  assert.equal(bridge.stdioOutput, stdout);
  assert.equal(bridge.onStdioFatalError, onFatalError);
  assert.equal(stdin.listenerCount('data'), 1);

  const response = readJsonLine(stdout);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 83, method: 'ping' })}\n`);
  assert.deepEqual(await response, { jsonrpc: '2.0', id: 83, result: {} });
});

test('stdio configured while MCP is disabled starts on the first enable', async t => {
  const bridge = createBridge(false);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  t.after(async () => {
    await bridge.stop({ bestEffort: true });
    stdin.destroy();
    stdout.destroy();
  });

  await bridge.startStdio({ stdin, stdout });
  assert.equal(bridge.getStatus().stdioActive, false);
  assert.equal(stdin.listenerCount('data'), 0);

  await bridge.setEnabled(true);
  assert.equal(bridge.getStatus().stdioActive, true);
  assert.equal(stdin.listenerCount('data'), 1);
});

test('failed stdio cleanup rollback retains one reader until cleanup can retry', async t => {
  const bridge = createBridge();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = [];
  stdout.on('data', chunk => output.push(Buffer.from(chunk)));
  await bridge.startStdio({ stdin, stdout });
  const retainedTransport = bridge.stdioTransport;
  const originalClose = retainedTransport.close.bind(retainedTransport);
  retainedTransport.close = async () => {
    throw new Error('stdio close blocked');
  };
  t.after(async () => {
    retainedTransport.close = originalClose;
    await bridge.stop({ bestEffort: true });
    stdin.destroy();
    stdout.destroy();
  });
  const settingsWrites = [];
  const api = new ApiServer(createProxy(), null, null);
  api.settings = { setAll: values => settingsWrites.push(values) };
  api.setMcpBridge(bridge);

  await assert.rejects(
    api._setMcpEnabled(false),
    error => error instanceof AggregateError && /degraded|cleanup/i.test(error.message)
  );

  assert.deepEqual(settingsWrites, []);
  assert.equal(bridge.getStatus().enabled, true);
  assert.equal(bridge.getStatus().degraded, true);
  assert.equal(bridge.getStatus().pendingCleanupCount, 1);
  assert.equal(stdin.listenerCount('data'), 1);
  assert.equal(stdin.listenerCount('error'), 1);

  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 830, method: 'ping' })}\n`);
  await new Promise(resolve => setTimeout(resolve, 20));
  const responses = Buffer.concat(output)
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 830, result: {} }]);
});

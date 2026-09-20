import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ApiServer } from '../../src/api/api-server.js';
import { McpServerBridge } from '../../src/mcp/mcp-server.js';
import { startStdioBridge } from '../../src/mcp/stdio-bridge.js';

const IDLE_TIMEOUT_MS = 100;
const TOKEN = 'idle-session-secret';

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function createServer(t) {
  const proxy = { port: 8081, mockRules: [], breakpointRules: [],
    matchApiSpec: () => null, getStats: () => ({}) };
  const api = new ApiServer(proxy, null, null, {
    authToken: TOKEN, managementRequestTimeoutMs: IDLE_TIMEOUT_MS
  });
  const bridge = new McpServerBridge({
    apiServer: api, proxyServer: proxy, interceptorManager: { getAll: async () => [] }
  });
  api.setMcpBridge(bridge);
  bridge.startSse(api.app);
  api.port = 0;
  await api.start();
  t.after(async () => {
    await bridge.stop({ bestEffort: true });
    await api.stop();
  });
  return { api, bridge, port: api.httpServer.address().port };
}

async function openSse(t, port) {
  const events = [];
  const request = http.get({
    hostname: '127.0.0.1', port, path: '/mcp/sse',
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  t.after(() => request.destroy());
  const response = await new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  response.on('error', () => {});
  assert.equal(response.statusCode, 200);
  let buffered = '';
  response.on('data', chunk => {
    buffered += chunk.toString();
    let separator;
    while ((separator = buffered.indexOf('\n\n')) >= 0) {
      const event = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 2);
      events.push({
        type: event.match(/^event: (.+)$/m)?.[1], data: event.match(/^data: (.+)$/m)?.[1]
      });
    }
  });
  await waitFor(() => events.some(event => event.type === 'endpoint'), 'SSE endpoint was not received');
  return { request, response, events, endpoint: events.find(event => event.type === 'endpoint').data };
}

function postMessage(port, endpoint, id) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
    const request = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload) }
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('an admitted SSE stream survives management idle timeouts and still processes messages', async t => {
  const { bridge, port } = await createServer(t);
  const stream = await openSse(t, port);
  const sessionId = new URL(stream.endpoint, 'http://localhost').searchParams.get('sessionId');
  const session = bridge.sseSessions.get(sessionId);
  await delay(IDLE_TIMEOUT_MS * 3);
  assert.equal(stream.response.destroyed, false);
  assert.equal(bridge.sseSessions.get(sessionId), session);
  assert.equal(await postMessage(port, stream.endpoint, 1), 202);
  await waitFor(() => stream.events.some(event => event.type === 'message'), 'Idle SSE stream did not deliver ping');
  assert.deepEqual(JSON.parse(stream.events.find(event => event.type === 'message').data), {
    jsonrpc: '2.0', id: 1, result: {}
  });

  stream.request.destroy();
  await waitFor(() => bridge.sseSessions.size === 0, 'Disconnected SSE session was retained');
  assert.equal(session.server.transport, undefined);
  assert.equal(await postMessage(port, stream.endpoint, 2), 404);
  assert.equal(bridge.getStatus().connectedClients, 0);
  assert.equal(bridge.getStatus().pendingCleanupCount, 0);
});

test('the production stdio bridge remains usable after SSE idle time and cleans up on EOF', async t => {
  const { bridge: serverBridge, port } = await createServer(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-sse-idle-'));
  const descriptor = path.join(directory, 'runtime.json');
  fs.writeFileSync(descriptor, JSON.stringify({ sseUrl: `http://127.0.0.1:${port}/mcp/sse`, authToken: TOKEN }));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  const originalExitCode = process.exitCode;
  let clientBridge;
  t.after(async () => {
    await clientBridge?.close();
    stdin.destroy();
    stdout.destroy();
    fs.unlinkSync(descriptor);
    fs.rmdirSync(directory);
    process.exitCode = originalExitCode;
  });
  clientBridge = await startStdioBridge(descriptor, { stdin, stdout });
  await delay(IDLE_TIMEOUT_MS * 3);
  assert.equal(clientBridge.isClosed, false);
  assert.equal(stdin.readableEnded, false);
  assert.equal(serverBridge.sseSessions.size, 1);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'ping' })}\n`);
  await waitFor(() => output.includes('\n'), 'Idle stdio bridge did not return ping');
  assert.deepEqual(JSON.parse(output.trim()), { jsonrpc: '2.0', id: 21, result: {} });
  stdin.end();
  await waitFor(() => clientBridge.isClosed, 'EOF did not close the bridge');
  const closed = await clientBridge.closed;
  assert.equal(closed.error, null);
  assert.deepEqual(closed.transports.map(result => result.status), ['fulfilled', 'fulfilled']);
  await waitFor(() => serverBridge.sseSessions.size === 0, 'EOF retained the SSE session');
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('close'), 0);
  assert.equal(process.exitCode, originalExitCode);
});

function waitForIdleDisconnect(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error('Ordinary management request escaped its idle timeout'));
    }, 2000);
    const chunks = [];
    socket.on('error', () => {});
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('connect', () => socket.write(requestText));
    socket.once('close', () => {
      clearTimeout(guard);
      resolve(Buffer.concat(chunks).toString());
    });
  });
}

test('ordinary requests and incomplete MCP uploads retain their management idle timeout', async t => {
  const { api, bridge, port } = await createServer(t);
  let ordinaryRouteRuns = 0;
  api.app.get('/api/idle-probe', () => { ordinaryRouteRuns++; });
  const headers = `Host: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n`;
  const stalled = await waitForIdleDisconnect(port, `GET /api/idle-probe HTTP/1.1\r\n${headers}\r\n`);
  assert.equal(stalled, '');
  assert.equal(ordinaryRouteRuns, 1);

  const partialBody = 'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"partial":';
  await waitForIdleDisconnect(port, `GET /mcp/sse HTTP/1.1\r\n${headers}${partialBody}`);
  assert.equal(bridge.sseSessions.size, 0);
  const stream = await openSse(t, port);
  await waitForIdleDisconnect(port, `POST ${stream.endpoint} HTTP/1.1\r\n${headers}${partialBody}`);
  assert.equal(bridge.sseSessions.size, 1);
  assert.equal(await postMessage(port, stream.endpoint, 30), 202);
  await waitFor(() => stream.events.some(event => event.type === 'message'), 'Upload timeout damaged its SSE session');

  await bridge.stop();
  await waitFor(() => stream.response.complete, 'MCP stop did not end SSE response');
  assert.equal(bridge.sseSessions.size, 0);
  assert.equal(bridge.getStatus().pendingCleanupCount, 0);
});

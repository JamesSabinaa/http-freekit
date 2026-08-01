import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';

import { ApiServer } from '../../src/api/api-server.js';

const AUTH_TOKEN = 'bug-289-secret';

function createApi() {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { authToken: AUTH_TOKEN });
  api.port = 0;
  return api;
}

function authenticatedUpgradeRequest() {
  return [
    `GET /ws?authToken=${AUTH_TOKEN} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '',
    ''
  ].join('\r\n');
}

async function sendMalformedAuthenticatedFrame(port) {
  const socket = net.connect(port, '127.0.0.1');
  const chunks = [];
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  await once(socket, 'connect');

  // Include an unmasked client frame in the upgrade head. The ws parser rejects
  // it after accepting the authenticated upgrade, exercising the earliest point
  // at which a peer-scoped error listener can be attached.
  socket.write(Buffer.concat([
    Buffer.from(authenticatedUpgradeRequest(), 'latin1'),
    Buffer.from([0x81, 0x01, 0x61])
  ]));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(reject, new Error('Malformed management WebSocket was not closed')),
      2000
    );
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      callback(value);
    };
    const onClose = () => finish(resolve);
    const onError = error => {
      if (error.code !== 'ECONNRESET') finish(reject, error);
    };
    socket.once('close', onClose);
    socket.once('error', onError);
  });
  return Buffer.concat(chunks).toString('latin1');
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function getVersion(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/version',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
  });
}

function parseMessage(args) {
  return JSON.parse(args[0].toString('utf8'));
}

test('malformed authenticated WebSocket peers are isolated without crashing management APIs', async t => {
  const logs = [];
  const warnings = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const api = createApi();
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;

  const malformedResponse = await sendMalformedAuthenticatedFrame(port);
  assert.match(malformedResponse, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.equal(api.clients.size, 0);
  assert.equal(api.httpServer.listening, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Invalid WebSocket frame: MASK must be set/);

  const version = await getVersion(port);
  assert.equal(version.statusCode, 200);
  assert.deepEqual(version.body, { version: '1.0.0', name: 'HTTP FreeKit' });

  const valid = new WebSocket(`ws://127.0.0.1:${port}/ws?authToken=${AUTH_TOKEN}`);
  t.after(() => valid.terminate());
  const init = parseMessage(await once(valid, 'message'));
  assert.equal(init.type, 'init');
  assert.equal(init.apiPort, 0);
  assert.equal(api.clients.size, 1);

  const trafficDumpPromise = once(valid, 'message');
  valid.send(JSON.stringify({ type: 'get-traffic', limit: 1 }));
  const trafficDump = parseMessage(await trafficDumpPromise);
  assert.equal(trafficDump.type, 'traffic-dump');
  assert.deepEqual(trafficDump.requests, []);

  const validClosed = once(valid, 'close');
  valid.close();
  await validClosed;
  await waitFor(() => api.clients.size === 0, 'Valid WebSocket close was not accounted for');

  assert.equal(logs.filter(message => message.includes('WebSocket client connected')).length, 2);
  assert.equal(logs.filter(message => message.includes('WebSocket client disconnected')).length, 2);
});

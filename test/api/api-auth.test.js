import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';
import { ApiServer } from '../../src/api/api-server.js';

function request(port, path, { token, origin, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    headers = { ...headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const req = http.request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

function rawRequest(port, headers, { upgrade = false, version = '1.1' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('Management request timed out')));
    socket.once('error', reject);
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('connect', () => socket.end([
      `GET ${upgrade ? '/ws' : '/api/traffic'} HTTP/${version}`,
      ...headers,
      ...(upgrade ? [
        'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'
      ] : ['Connection: close']),
      '', ''
    ].join('\r\n')));
  });
}

test('tokenless management traffic rejects foreign or ambiguous authorities without Origin', async t => {
  const proxy = { port: 8081, bindHost: '0.0.0.0', mockRules: [], matchApiSpec: () => null };
  const api = new ApiServer(proxy);
  api.port = 0;
  api.trafficLog = [{ id: 'private-record', requestHeaders: { authorization: 'synthetic-secret' } }];
  api.app.get('/mcp/authority-probe', (_req, res) => res.json({ private: true }));
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;

  for (const host of [
    `untrusted.example:${port}`, `localhost.untrusted.example:${port}`,
    `192.0.2.1:${port}`, `0.0.0.0:${port}`, `[::]:${port}`,
    `127.0.0.1:${port === 65535 ? 65534 : port + 1}`,
    '127.0.0.1', `127.0.0.1:${port}/path`, `localhost:${port}?query`,
    `localhost:${port}#fragment`, `user@localhost:${port}`, 'localhost:', '[::1'
  ]) {
    const response = await request(port, '/api/traffic', {
      headers: { Host: host, 'X-Forwarded-Host': `localhost:${port}`, Forwarded: `host=localhost:${port}` }
    });
    assert.equal(response.statusCode, 403, host);
    assert.doesNotMatch(response.body, /private-record|synthetic-secret/);
    assert.match(await rawRequest(port, [`Host: ${host}`], { upgrade: true }), /^HTTP\/1\.1 403 /, host);
  }
  const mcp = await request(port, '/mcp/authority-probe', { headers: { Host: `untrusted.example:${port}` } });
  assert.equal(mcp.statusCode, 403);
  const preflight = await request(port, '/api/traffic', { method: 'OPTIONS', headers: { Host: `untrusted.example:${port}` } });
  assert.equal(preflight.statusCode, 403);
  for (const headers of [
    [`Host: localhost:${port}`, `hOsT: untrusted.example:${port}`],
    [`Host: untrusted.example:${port}`, `Host: localhost:${port}`]
  ]) {
    assert.match(await rawRequest(port, headers), /^HTTP\/1\.1 403 /);
    assert.match(await rawRequest(port, headers, { upgrade: true }), /^HTTP\/1\.1 403 /);
  }
  assert.match(await rawRequest(port, [], { version: '1.0' }), /^HTTP\/1\.1 403 /);
  assert.match(await rawRequest(port, [], { upgrade: true, version: '1.0' }), /^HTTP\/1\.1 403 /);
  await expectWebSocketRejection(`ws://127.0.0.1:${port}/ws`, {
    headers: { Host: `untrusted.example:${port}`, 'X-Forwarded-Host': `localhost:${port}` }
  }, 403);
  assert.equal(api.clients.size, 0);
});

test('tokenless management accepts loopback authorities on its actual bound port', async t => {
  const api = new ApiServer({ port: 8081, bindHost: '::', mockRules: [], matchApiSpec: () => null });
  api.port = 0;
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;
  for (const host of ['127.0.0.1', '127.0.0.2', 'LOCALHOST', 'localhost.', '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]']) {
    const headers = { Host: `${host}:${port}`, 'X-Forwarded-Host': 'untrusted.example' };
    assert.equal((await request(port, '/api/version', { headers })).statusCode, 200, host);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    t.after(() => ws.terminate());
    const message = await new Promise((resolve, reject) => {
      ws.once('message', data => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
    });
    assert.equal(message.type, 'init');
    ws.close();
  }
});

test('tokenless authority uses effective HTTP default port and rejects malformed or missing Host', () => {
  const api = new ApiServer({ mockRules: [] });
  const accepts = (host, localPort) => api._isAllowedRequestAuthority({
    headers: { host }, rawHeaders: host === undefined ? [] : ['Host', host], socket: { localPort }
  });
  for (const host of ['localhost', '127.0.0.1', '[::1]', '[0:0:0:0:0:0:0:1]']) {
    assert.equal(accepts(host, 80), true, host);
    assert.equal(accepts(`${host}:80`, 80), true, host);
    assert.equal(accepts(host, 8080), false, host);
    assert.equal(accepts(`${host}:8080`, 8080), true, host);
  }
  for (const host of [undefined, '', [], 'localhost:', 'localhost:abc', 'localhost:65536', 'localhost:0', ' localhost:80', 'localhost:80 ', 'localhost:80\\evil', '::1:80']) {
    assert.equal(accepts(host, 80), false, String(host));
  }
});

test('configured desktop token keeps its authentication contract for a custom authority', async t => {
  const api = new ApiServer({ port: 8081, bindHost: '192.0.2.1', mockRules: [], matchApiSpec: () => null }, null, null, { authToken: 'session-secret' });
  api.port = 0;
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;
  const headers = { Host: `custom.example:${port}` };
  assert.equal((await request(port, '/api/version', { headers })).statusCode, 401);
  assert.equal((await request(port, '/api/version', { headers, token: 'wrong-secret' })).statusCode, 401);
  assert.equal((await request(port, '/api/version', { headers, token: 'session-secret' })).statusCode, 200);
  assert.equal((await request(port, '/api/version', { headers, token: 'session-secret', origin: 'http://custom.example' })).statusCode, 403);
  await expectWebSocketRejection(`ws://127.0.0.1:${port}/ws`, { headers }, 401);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?authToken=session-secret`, { headers });
  t.after(() => ws.terminate());
  const message = await new Promise((resolve, reject) => {
    ws.once('message', data => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
  assert.equal(message.type, 'init');
  ws.close();
});

function expectWebSocketRejection(url, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('unexpected-response', (_request, response) => {
      try {
        assert.equal(response.statusCode, expectedStatus);
        response.resume();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    ws.once('open', () => reject(new Error('WebSocket unexpectedly connected')));
    ws.once('error', () => {});
  });
}

test('management API and WebSocket require the Electron session token', async (t) => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { authToken: 'session-secret' });
  api.port = 0;
  api.trafficLog = [{ id: 'private-record' }];
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;

  const unauthorized = await request(port, '/api/traffic');
  assert.equal(unauthorized.statusCode, 401);

  const foreignOrigin = await request(port, '/api/traffic', {
    token: 'session-secret',
    origin: 'https://attacker.example'
  });
  assert.equal(foreignOrigin.statusCode, 403);
  assert.equal(foreignOrigin.headers['access-control-allow-origin'], undefined);

  const authorized = await request(port, '/api/traffic', { token: 'session-secret' });
  assert.equal(authorized.statusCode, 200);
  assert.match(authorized.body, /private-record/);

  await expectWebSocketRejection(`ws://127.0.0.1:${port}/ws`, {}, 401);
  await expectWebSocketRejection(
    `ws://127.0.0.1:${port}/ws?authToken=session-secret`,
    { origin: 'https://attacker.example' },
    403
  );

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?authToken=session-secret`);
  t.after(() => ws.close());
  const firstMessage = await new Promise((resolve, reject) => {
    ws.once('message', data => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
  assert.equal(firstMessage.type, 'init');
});

test('browser origins compare effective default ports without accepting other hosts or ports', () => {
  const api = new ApiServer({ mockRules: [] }, null, null);
  for (const [protocol, port] of [['http', 80], ['https', 443]]) {
    api.port = port;
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      assert.equal(api._isAllowedBrowserOrigin(`${protocol}://${host}`), true);
      assert.equal(api._isAllowedBrowserOrigin(`${protocol}://${host}:${port}`), true);
      assert.equal(api._isAllowedBrowserOrigin(`${protocol}://${host}:8080`), false);
    }
    assert.equal(api._isAllowedBrowserOrigin(`${protocol}://attacker.example:${port}`), false);
  }
  api.port = 8080;
  assert.equal(api._isAllowedBrowserOrigin('http://localhost:8080'), true);
  assert.equal(api._isAllowedBrowserOrigin('http://localhost'), false);
  assert.equal(api._isAllowedBrowserOrigin('https://localhost'), false);
  assert.equal(api._isAllowedBrowserOrigin('null'), false);
});

test('configured port 80 accepts authenticated browser POST and WebSocket origins', async t => {
  const proxy = { port: 8081, mockRules: [], matchApiSpec: () => null };
  const api = new ApiServer(proxy, null, null, { authToken: 'session-secret' });
  api.app.post('/api/origin-probe', (_req, res) => res.json({ ok: true }));
  api.port = 0;
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;
  // Keep the listener ephemeral while exercising the configured-port policy.
  api.port = 80;
  for (const origin of ['http://127.0.0.1', 'http://127.0.0.1:80']) {
    const response = await request(port, '/api/origin-probe', {
      method: 'POST', token: 'session-secret', origin
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?authToken=session-secret`, { origin });
    t.after(() => ws.terminate());
    const message = await new Promise((resolve, reject) => {
      ws.once('message', data => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
    });
    assert.equal(message.type, 'init');
    ws.close();
  }
  const unauthorized = await request(port, '/api/origin-probe', {
    method: 'POST', origin: 'http://127.0.0.1'
  });
  assert.equal(unauthorized.statusCode, 401);
  for (const origin of ['http://127.0.0.1:8080', 'http://attacker.example']) {
    const response = await request(port, '/api/origin-probe', {
      method: 'POST', token: 'session-secret', origin
    });
    assert.equal(response.statusCode, 403);
    await expectWebSocketRejection(`ws://127.0.0.1:${port}/ws?authToken=session-secret`, { origin }, 403);
  }
});

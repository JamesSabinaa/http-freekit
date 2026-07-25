import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';
import { McpServerBridge } from '../src/mcp/mcp-server.js';

function request(port, path, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

function readSseEndpoint(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk.toString('utf8');
        const match = body.match(/event: endpoint\ndata: ([^\n]+)/);
        if (match) {
          resolve({ statusCode: res.statusCode, endpoint: match[1] });
          req.destroy();
        }
      });
    });
    req.once('error', err => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

test('MCP SSE and message endpoints require the session token', async (t) => {
  const proxy = {
    port: 8081,
    mockRules: [],
    breakpointRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    getStats: () => ({}),
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { authToken: 'session-secret' });
  const bridge = new McpServerBridge({
    apiServer: api,
    proxyServer: proxy,
    interceptorManager: { getAll: async () => [] }
  });
  api.setMcpBridge(bridge);
  bridge.startSse(api.app);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await bridge.stop();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;

  const noSseToken = await request(port, '/mcp/sse');
  assert.equal(noSseToken.statusCode, 401);

  const noMessageToken = await request(port, '/mcp/messages?sessionId=unknown', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  assert.equal(noMessageToken.statusCode, 401);

  const authorizedMessage = await request(port, '/mcp/messages?sessionId=unknown', {
    method: 'POST',
    token: 'session-secret',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  assert.equal(authorizedMessage.statusCode, 404);

  const sse = await readSseEndpoint(port, '/mcp/sse?authToken=session-secret');
  assert.equal(sse.statusCode, 200);
  assert.match(sse.endpoint, /^\/mcp\/messages\?authToken=session-secret&sessionId=/);
});

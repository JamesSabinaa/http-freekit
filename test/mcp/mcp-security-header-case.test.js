import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { McpServerBridge } from '../../src/mcp/mcp-server.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function importedRequest(id, responseHeaders, overrides = {}) {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'https',
    method: 'GET',
    host: `${id}.example`,
    url: `https://${id}.example/`,
    path: '/',
    statusCode: 200,
    source: 'import',
    responseHeaders,
    ...overrides
  };
}

test('MCP security scan finds mixed-case imported headers without mutating traffic', async t => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const requests = [
    importedRequest('vulnerable', {
      'sEt-CoOkIe': [
        'session=abc; Path=/',
        'preferences=dark; Secure; Path=/'
      ],
      'CoNtEnT-TyPe': ['application/json', 'text/html; charset=utf-8'],
      'Content-Security-Policy': "default-src 'self'",
      'StRiCt-TrAnSpOrT-SeCuRiTy': 'max-age=31536000',
      'X-FrAmE-OpTiOnS': 'DENY',
      'AcCeSs-CoNtRoL-AlLoW-OrIgIn': '*'
    }),
    importedRequest('protected', {
      'SeT-cOoKiE': 'safe=value; Secure; HttpOnly',
      'CONTENT-type': 'text/html',
      'cOnTeNt-SeCuRiTy-PoLiCy': "default-src 'none'",
      'STRICT-transport-SECURITY': 'max-age=31536000',
      'x-FRAME-options': 'DENY',
      'X-CoNtEnT-TyPe-OpTiOnS': 'nosniff',
      'Access-Control-Allow-Origin': 'https://app.example'
    }),
    importedRequest('skipped-mock', {
      'Set-Cookie': 'mock=value',
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*'
    }, { source: 'mock' }),
    importedRequest('skipped-status', {
      'Set-Cookie': 'pending=value',
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*'
    }, { statusCode: 0 })
  ];

  const imported = await postJson(server.address().port, { requests });
  assert.equal(imported.statusCode, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.imported, requests.length);

  const beforeScan = structuredClone(api.trafficLog);
  const bridge = new McpServerBridge({
    apiServer: api,
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  const report = JSON.parse(bridge._handleSecurityScan().content[0].text);

  const insecureCookies = report.issues.filter(issue => issue.category === 'Insecure Cookie');
  assert.deepEqual(insecureCookies.map(issue => issue.requestId), [
    'vulnerable',
    'vulnerable',
    'vulnerable'
  ]);
  assert.deepEqual(insecureCookies.map(issue => issue.description), [
    'Cookie missing Secure flag: session=abc',
    'Cookie missing HttpOnly flag: session=abc',
    'Cookie missing HttpOnly flag: preferences=dark'
  ]);

  const missingHeaders = report.issues.filter(issue => issue.category === 'Missing Security Header');
  assert.deepEqual(missingHeaders.map(issue => [issue.requestId, issue.description]), [[
    'vulnerable',
    'Missing x-content-type-options header on HTML response'
  ]]);

  const corsIssues = report.issues.filter(issue => issue.category === 'CORS Wildcard');
  assert.deepEqual(corsIssues.map(issue => issue.requestId), ['vulnerable']);
  assert.equal(report.issues.some(issue => issue.requestId === 'protected'), false);
  assert.equal(report.issues.some(issue => issue.requestId.startsWith('skipped-')), false);
  assert.deepEqual(api.trafficLog, beforeScan);
});

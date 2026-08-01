import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
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

async function createServer(t) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { proxy, port: server.address().port };
}

test('concurrent list additions retain both values', async t => {
  const { proxy, port } = await createServer(t);

  const [first, second] = await Promise.all([
    requestJson(port, 'POST', '/api/tls-passthrough/items', { host: 'one.test' }),
    requestJson(port, 'POST', '/api/tls-passthrough/items', { host: 'two.test' })
  ]);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(proxy.tlsPassthrough.sort(), ['one.test', 'two.test']);
});

test('stale removals delete the requested value rather than a current index', async t => {
  const { proxy, port } = await createServer(t);
  proxy.setHttpsWhitelist(['new-first.test', 'old-first.test', 'other.test']);

  const result = await requestJson(port, 'DELETE', '/api/https-whitelist/items', { host: 'old-first.test' });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(proxy.httpsWhitelist, ['new-first.test', 'other.test']);
});

test('client certificate and trusted CA mutations target stable values', async t => {
  const { proxy, port } = await createServer(t);
  proxy.setClientCertificates([{ host: 'a.test', pfxPath: 'a.pfx' }, { host: 'b.test', pfxPath: 'b.pfx' }]);
  proxy.setTrustedCAs(['new.pem', 'old.pem']);

  const certificate = await requestJson(port, 'DELETE', '/api/client-certificates/items', { host: 'b.test', pfxPath: 'b.pfx' });
  const ca = await requestJson(port, 'DELETE', '/api/trusted-cas/items', { ca: 'old.pem' });

  assert.equal(certificate.statusCode, 200);
  assert.equal(ca.statusCode, 200);
  assert.deepEqual(proxy.clientCertificates, [{ host: 'a.test', pfxPath: 'a.pfx' }]);
  assert.deepEqual(proxy.trustedCAs, ['new.pem']);
});

test('renderer list mutations use atomic item endpoints without preflight reads', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  for (const [startText, endText] of [
    ['async function addTlsPassthrough', '// ============ HTTP/2 CONFIG'],
    ['async function addClientCert', '// ============ TRUSTED CAs'],
    ['async function addTrustedCA', '// ============ HTTPS WHITELIST'],
    ['async function addHttpsWhitelist', '// ============ MCP SERVER']
  ]) {
    const start = source.indexOf(startText);
    const end = source.indexOf(endText, start);
    const section = source.slice(start, end);
    assert.match(section, /\/items/);
    assert.match(section, /method: 'DELETE'/);
    assert.doesNotMatch(section, /await fetch\(API_BASE \+ '\/api\/(?:tls-passthrough|client-certificates|trusted-cas|https-whitelist)'\);/);
  }
});

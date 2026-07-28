import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestThroughProxy(proxyPort, originPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: `http://127.0.0.1:${originPort}/real`,
      headers: {
        host: `127.0.0.1:${originPort}`,
        authorization: 'Bearer remove-me',
        'x-remove-me': 'yes'
      }
    }, (res) => {
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

async function runBreakpointAction(t, actionType, modifications = {}) {
  let originHits = 0;
  let originHeaders;
  const events = [];
  const origin = http.createServer((req, res) => {
    originHits++;
    originHeaders = req.headers;
    res.writeHead(201, {
      'content-type': 'text/plain',
      'content-length': String(Buffer.byteLength('origin-body')),
      'x-origin': 'yes'
    });
    res.end('origin-body');
  });
  const originPort = await listen(origin);
  let proxy;
  proxy = new ProxyServer(null, {
    port: 0,
    onRequest: event => events.push(event),
    onBreakpoint: (event) => {
      if (event.type !== 'breakpoint-hit') return;
      setImmediate(() => proxy.resumeBreakpoint(event.requestId, modifications));
    }
  });
  proxy.mockRules = [{ enabled: true, matchers: [], action: { type: actionType } }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const response = await requestThroughProxy(proxy.server.address().port, originPort);
  return { response, originHits, originHeaders, events };
}

test('request breakpoint mock actions resume into the real origin request', async (t) => {
  const { response, originHits, originHeaders } = await runBreakpointAction(
    t,
    'breakpoint-request',
    { headers: { 'x-kept': 'yes' } }
  );

  assert.equal(originHits, 1);
  assert.equal(originHeaders.authorization, undefined);
  assert.equal(originHeaders['x-remove-me'], undefined);
  assert.equal(originHeaders['x-kept'], 'yes');
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['x-origin'], 'yes');
  assert.equal(response.body, 'origin-body');
});

test('response breakpoint mock actions pause the real response and apply edits', async (t) => {
  const { response, originHits, events } = await runBreakpointAction(t, 'breakpoint-response', {
    status: 202,
    headers: { 'content-type': 'text/plain', 'content-length': '11', 'x-edited': 'yes' },
    body: 'edited-response-body'
  });

  assert.equal(originHits, 1);
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers['x-edited'], 'yes');
  assert.equal(response.body, 'edited-response-body');
  assert.equal(response.headers['content-length'], String(Buffer.byteLength('edited-response-body')));
  assert.ok(events.some(event =>
    event.breakpointPhase === 'response' &&
    event.upstreamStatusCode === 201 &&
    event.responseBody === 'origin-body'
  ));
});

test('renderer exposes response breakpoint status, headers, and body edits', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');
  assert.match(source, /req\.breakpointPhase === 'response'/);
  assert.match(source, /\['status', 'headers', 'body'\]/);
  assert.match(source, /Response status:/);
});

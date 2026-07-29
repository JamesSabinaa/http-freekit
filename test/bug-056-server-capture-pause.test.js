import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

function createApi() {
  return new ApiServer({
    port: 8080,
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null,
    getStats: () => ({})
  }, null, null);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestJson(port, requestPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encodedBody === null ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encodedBody)
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
    request.end(encodedBody);
  });
}

test('paused capture drops whole new proxy lifecycles but completes rows retained before Pause', () => {
  const api = createApi();
  const broadcasts = [];
  const rotated = [];
  api._broadcast = message => broadcasts.push(structuredClone(message));
  api._maybeAutoRotateProxyOnError = data => rotated.push(data.id);

  api.onTrafficEvent({
    id: 'before-pause',
    trafficLifecycleId: 'before-life',
    source: 'proxy',
    _pending: true,
    _trafficLifecycleComplete: false
  });
  api._setCapturePaused(true);

  assert.equal(api.onTrafficEvent({
    id: 'during-pause',
    trafficLifecycleId: 'paused-life',
    source: 'proxy',
    _pending: true,
    _trafficLifecycleComplete: false
  }), false);
  api._setCapturePaused(false);
  assert.equal(api.onTrafficEvent({
    id: 'during-pause',
    trafficLifecycleId: 'paused-life',
    source: 'proxy',
    _update: true,
    statusCode: 503
  }), false, 'resuming must not surface a completion whose pending row was paused');

  api._setCapturePaused(true);
  api.onTrafficEvent({
    id: 'before-pause',
    trafficLifecycleId: 'before-life',
    source: 'proxy',
    _update: true,
    statusCode: 204
  });
  api.onTrafficEvent({
    id: 'send-while-paused',
    trafficLifecycleId: 'send-life',
    source: 'Send',
    statusCode: 200
  });

  assert.deepEqual(api.trafficLog.map(request => [request.id, request.statusCode]), [
    ['before-pause', 204],
    ['send-while-paused', 200]
  ]);
  assert.equal(api._captureSuppressedTrafficIdentities.size, 0);
  assert.deepEqual(rotated, ['during-pause', 'before-pause']);
  assert.deepEqual(
    broadcasts.filter(message => message.type === 'request').map(message => message.data.id),
    ['before-pause', 'send-while-paused']
  );
  assert.deepEqual(
    broadcasts.filter(message => message.type === 'request-update').map(message => message.data.id),
    ['before-pause']
  );
});

test('capture state API validates, applies, and broadcasts one shared state', async t => {
  const api = createApi();
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const invalid = await requestJson(port, '/api/traffic/capture', {
    method: 'PUT',
    body: { paused: 'yes' }
  });
  assert.equal(invalid.statusCode, 400);

  const paused = await requestJson(port, '/api/traffic/capture', {
    method: 'PUT',
    body: { paused: true }
  });
  const duplicate = await requestJson(port, '/api/traffic/capture', {
    method: 'PUT',
    body: { paused: true }
  });
  const current = await requestJson(port, '/api/traffic/capture');

  assert.deepEqual(paused, { statusCode: 200, body: { success: true, paused: true } });
  assert.deepEqual(duplicate, paused);
  assert.deepEqual(current, { statusCode: 200, body: { paused: true } });
  assert.deepEqual(broadcasts, [{ type: 'capture-state', paused: true }]);
});

test('renderer requests authoritative pause changes and renders server broadcasts', async () => {
  const renderer = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = renderer.indexOf('function applyCapturePausedState(');
  const end = renderer.indexOf('// ============ TRAFFIC ============', start);
  const toggleStart = renderer.indexOf('function togglePause(');
  const toggleEnd = renderer.indexOf('function downloadCert()', toggleStart);
  const pauseSource = renderer.slice(start, end) + renderer.slice(toggleStart, toggleEnd);
  const websocketStart = renderer.indexOf('function handleWsMessage(msg)');
  const websocketEnd = renderer.indexOf('// ============ TRAFFIC ============', websocketStart);
  const websocketSource = renderer.slice(websocketStart, websocketEnd);
  const button = {
    attributes: new Map(),
    style: {},
    setAttribute(name, value) { this.attributes.set(name, value); }
  };
  const requests = [];
  let renders = 0;
  const context = vm.createContext({
    API_BASE: '',
    console,
    document: { getElementById: id => id === 'pauseBtn' ? button : null },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ success: true, paused: true }) };
    },
    renderTraffic: () => { renders += 1; },
    toast: () => {}
  });
  vm.runInContext(`
    let isPaused = false;
    let pauseMutationPending = false;
    ${pauseSource}
    globalThis.applyPauseForTest = applyCapturePausedState;
    globalThis.togglePauseForTest = togglePause;
  `, context);

  await context.togglePauseForTest();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/traffic/capture');
  assert.equal(requests[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[0].options.body), { paused: true });
  assert.equal(button.title, 'Resume capture');
  assert.equal(button.attributes.get('aria-pressed'), 'true');
  assert.equal(button.attributes.get('aria-disabled'), 'false');
  assert.equal(renders, 1);
  assert.match(websocketSource, /case 'init':[\s\S]*applyCapturePausedState\(msg\.capturePaused === true\)/);
  assert.match(websocketSource, /case 'capture-state':[\s\S]*applyCapturePausedState\(msg\.paused === true\)/);
  assert.doesNotMatch(websocketSource, /!isPaused \|\| msg\.data\?\.source === 'Send'/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function postImport(port, requests) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ requests });
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
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

function trafficRecord(id, protocol, parentId) {
  return {
    id,
    timestamp: Date.now(),
    protocol,
    method: protocol === 'ws-frame' ? 'WS-FRAME' : 'WS',
    statusCode: protocol === 'ws-frame' ? 0 : 101,
    host: 'socket.test',
    path: '/stream',
    requestBody: protocol === 'ws-frame' ? id : '',
    requestBodySize: protocol === 'ws-frame' ? id.length : 0,
    ...(parentId === undefined ? {} : { parentId })
  };
}

function rendererHarness(initialRequests = []) {
  const stateStart = rendererSource.indexOf('// ============ WEBSOCKET FRAMES STATE ============');
  const stateEnd = rendererSource.indexOf('// ============ VIRTUAL SCROLL STATE', stateStart);
  const restoreStart = rendererSource.indexOf('function trimTrafficRows(');
  const restoreEnd = rendererSource.indexOf('const appliedTrafficClearIds', restoreStart);
  const trafficStart = rendererSource.indexOf('function addRequest(');
  const trafficEnd = rendererSource.indexOf('function parseFilters(', trafficStart);
  const rowStart = rendererSource.indexOf('function buildRowHtml(');
  const rowEnd = rendererSource.indexOf('// Render the visible virtual-scroll rows', rowStart);
  for (const position of [stateStart, stateEnd, restoreStart, restoreEnd, trafficStart, trafficEnd, rowStart, rowEnd]) {
    assert.notEqual(position, -1, 'renderer traffic function marker must exist');
  }

  let renders = 0;
  const context = {
    requests: structuredClone(initialRequests),
    filteredRequests: [],
    selectedRequestId: null,
    requestCounter: initialRequests.length,
    sortField: null,
    sortDirection: 'desc',
    hideTunnelRequests: false,
    filterSafeFonts: false,
    document: {
      getElementById(id) {
        if (id === 'searchInput') return { value: '' };
        return null;
      }
    },
    closeDetail: () => {},
    showDetail: () => {},
    renderTraffic: () => { renders++; },
    esc: value => String(value ?? ''),
    formatSize: value => `${value || 0} B`,
    SOURCE_ICONS: { proxy: '' }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(stateStart, stateEnd)}
    ${rendererSource.slice(restoreStart, restoreEnd)}
    ${rendererSource.slice(trafficStart, trafficEnd)}
    ${rendererSource.slice(rowStart, rowEnd)}
    globalThis.addTrafficRequest = addRequest;
    globalThis.reloadTraffic = restoreTrafficDump;
    globalThis.expandTraffic = parentId => wsExpandedConnections.add(parentId);
    globalThis.expandTrafficRequest = request => wsExpandedConnections.add(wsConnectionKey(request));
    globalThis.filterTraffic = applyFilter;
    globalThis.filteredTrafficIds = () => filteredRequests.map(request => request.id);
    globalThis.frameIndex = () => Object.fromEntries(
      Object.entries(wsFramesByParent).map(([parentId, frames]) => [
        parentId,
        frames.map(frame => frame.id)
      ])
    );
    globalThis.frameIndexHasNullPrototype = () => Object.getPrototypeOf(wsFramesByParent) === null;
    globalThis.trafficRowHtml = requestId => buildRowHtml(
      requests.find(request => request.id === requestId),
      0
    );
  `, context);
  return { context, get renders() { return renders; } };
}

test('traffic import requires every WebSocket frame to have a non-empty string parent ID', async t => {
  const api = new ApiServer({
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  for (const malformed of [
    trafficRecord('missing-parent', 'ws-frame'),
    trafficRecord('empty-parent', 'ws-frame', ''),
    trafficRecord('numeric-parent', 'ws-frame', 7)
  ]) {
    const result = await postImport(port, [malformed]);
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /parentId/);
  }
  assert.deepEqual(api.trafficLog, []);

  const imported = [
    trafficRecord('__proto__', 'ws'),
    trafficRecord('proto-frame', 'ws-frame', '__proto__'),
    trafficRecord('constructor', 'ws'),
    trafficRecord('constructor-frame', 'ws-frame', 'constructor'),
    trafficRecord('ordinary-parent', 'ws'),
    trafficRecord('ordinary-frame', 'ws-frame', 'ordinary-parent')
  ];
  const result = await postImport(port, imported);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.imported, imported.length);
  assert.deepEqual(api.trafficLog, imported);
});

test('prototype-named parent IDs survive live add, filtering, reload, and row rendering', () => {
  const live = rendererHarness();
  for (const request of [
    trafficRecord('__proto__', 'ws'),
    trafficRecord('proto-frame', 'ws-frame', '__proto__'),
    trafficRecord('constructor', 'ws'),
    trafficRecord('constructor-frame', 'ws-frame', 'constructor'),
    trafficRecord('ordinary-parent', 'ws'),
    trafficRecord('ordinary-frame', 'ws-frame', 'ordinary-parent')
  ]) {
    assert.doesNotThrow(() => live.context.addTrafficRequest(request));
  }
  assert.equal(live.context.frameIndexHasNullPrototype(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(live.context.frameIndex())),
    Object.fromEntries([
      ['__proto__', ['proto-frame']],
      ['constructor', ['constructor-frame']],
      ['ordinary-parent', ['ordinary-frame']]
    ])
  );

  for (const parentId of ['__proto__', 'constructor', 'ordinary-parent']) {
    live.context.expandTraffic(parentId);
  }
  live.context.filterTraffic();
  assert.deepEqual(Array.from(live.context.filteredTrafficIds()), [
    '__proto__',
    'proto-frame',
    'constructor',
    'constructor-frame',
    'ordinary-parent',
    'ordinary-frame'
  ]);
  for (const parentId of ['__proto__', 'constructor', 'ordinary-parent']) {
    const html = live.context.trafficRowHtml(parentId);
    assert.match(html, /ws-frame-count">1</);
  }
  assert.ok(live.renders > 0);

  const reloaded = rendererHarness();
  for (const parentId of ['__proto__', 'constructor', 'ordinary-parent']) {
    reloaded.context.expandTraffic(parentId);
  }
  assert.doesNotThrow(() => reloaded.context.reloadTraffic([
    trafficRecord('__proto__', 'ws'),
    trafficRecord('proto-frame', 'ws-frame', '__proto__'),
    trafficRecord('constructor', 'ws'),
    trafficRecord('constructor-frame', 'ws-frame', 'constructor'),
    trafficRecord('ordinary-parent', 'ws'),
    trafficRecord('ordinary-frame', 'ws-frame', 'ordinary-parent')
  ]));
  assert.equal(reloaded.context.frameIndexHasNullPrototype(), true);
  assert.deepEqual(Array.from(reloaded.context.filteredTrafficIds()), [
    '__proto__',
    'proto-frame',
    'constructor',
    'constructor-frame',
    'ordinary-parent',
    'ordinary-frame'
  ]);
});

test('reused WebSocket IDs keep frames bound to the matching parent lifecycle', () => {
  const oldParent = {
    ...trafficRecord('reused', 'ws'),
    trafficLifecycleId: 'old-lifecycle'
  };
  const currentParent = {
    ...trafficRecord('reused', 'ws'),
    trafficLifecycleId: 'current-lifecycle'
  };
  const oldFrame = {
    ...trafficRecord('old-frame', 'ws-frame', 'reused'),
    parentTrafficLifecycleId: 'old-lifecycle'
  };
  const currentFrame = {
    ...trafficRecord('current-frame', 'ws-frame', 'reused'),
    parentTrafficLifecycleId: 'current-lifecycle'
  };
  const harness = rendererHarness([oldParent, oldFrame, currentParent, currentFrame]);

  harness.context.expandTrafficRequest(currentParent);
  harness.context.filterTraffic();

  assert.deepEqual(Array.from(harness.context.filteredTrafficIds()), [
    'reused',
    'reused',
    'current-frame'
  ]);
  assert.match(harness.context.trafficRowHtml('reused'), /ws-frame-count">1</);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function postJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
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

function postImport(port, requests) {
  return postJson(port, '/api/traffic/import', { requests });
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
  const toggleStart = rendererSource.indexOf('function toggleWsExpand(');
  const toggleEnd = rendererSource.indexOf('// ============ SCROLL TO END', toggleStart);
  for (const position of [
    stateStart, stateEnd, restoreStart, restoreEnd, trafficStart, trafficEnd,
    rowStart, rowEnd, toggleStart, toggleEnd
  ]) {
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
    ${rendererSource.slice(toggleStart, toggleEnd)}
    globalThis.addTrafficRequest = addRequest;
    globalThis.reloadTraffic = restoreTrafficDump;
    globalThis.expandTraffic = parentId => wsExpandedConnections.add(wsConnectionKey({ id: parentId }));
    globalThis.expandTrafficRequest = request => wsExpandedConnections.add(wsConnectionKey(request));
    globalThis.toggleTraffic = toggleWsExpand;
    globalThis.filterTraffic = applyFilter;
    globalThis.filteredTrafficIds = () => filteredRequests.map(request => request.id);
    globalThis.frameIndex = () => Object.fromEntries(
      Object.entries(wsFramesByParent).map(([parentId, frames]) => [
        parentId,
        frames.map(frame => frame.id)
      ])
    );
    globalThis.frameIndexHasNullPrototype = () => Object.getPrototypeOf(wsFramesByParent) === null;
    globalThis.frameIdsForRequest = request => (
      wsFramesByParent[wsConnectionKey(request)] || []
    ).map(frame => frame.id);
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
    trafficRecord('numeric-parent', 'ws-frame', 7),
    trafficRecord('orphan-parent', 'ws-frame', 'absent-parent')
  ]) {
    const result = await postImport(port, [malformed]);
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /parentId/);
  }
  assert.deepEqual(api.trafficLog, []);

  for (const emptyCorrelation of [
    { ...trafficRecord('empty-parent-lifecycle', 'ws'), trafficLifecycleId: '' },
    {
      ...trafficRecord('empty-frame-lifecycle', 'ws-frame', 'empty-parent-lifecycle'),
      parentTrafficLifecycleId: ''
    }
  ]) {
    const emptyResult = await postImport(port, [emptyCorrelation]);
    assert.equal(emptyResult.statusCode, 400);
    assert.match(emptyResult.body.error, /must be non-empty/);
  }
  assert.deepEqual(api.trafficLog, []);

  const mismatchedLifecycle = await postImport(port, [
    { ...trafficRecord('lifecycle-parent', 'wss'), trafficLifecycleId: 'actual-lifecycle' },
    {
      ...trafficRecord('mismatched-frame', 'ws-frame', 'lifecycle-parent'),
      parentTrafficLifecycleId: 'other-lifecycle'
    }
  ]);
  assert.equal(mismatchedLifecycle.statusCode, 400);
  assert.match(mismatchedLifecycle.body.error, /parentTrafficLifecycleId/);
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

  const linkedToRetainedParent = trafficRecord('retained-parent-frame', 'ws-frame', 'ordinary-parent');
  const retainedResult = await postImport(port, [linkedToRetainedParent]);
  assert.equal(retainedResult.statusCode, 200);
  assert.deepEqual(api.trafficLog.at(-1), linkedToRetainedParent);

  const mixedParent = {
    ...trafficRecord('mixed-endpoint-parent', 'wss'),
    trafficLifecycleId: 'mixed-endpoint-lifecycle'
  };
  const mixedFrame = trafficRecord('mixed-endpoint-frame', 'ws-frame', mixedParent.id);
  const mixedResult = await postImport(port, [mixedFrame, mixedParent]);
  assert.equal(mixedResult.statusCode, 200);
  assert.equal(
    api.trafficLog.find(request => request.id === mixedFrame.id).parentTrafficLifecycleId,
    mixedParent.trafficLifecycleId
  );
});

test('JSON and HAR imports preserve WebSocket parent relationships at capacity', async t => {
  const api = new ApiServer({
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null);
  api.maxTrafficLog = 3;
  api.trafficLog.push(trafficRecord('taken', 'https'));
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await postImport(port, [
    trafficRecord('taken', 'ws'),
    trafficRecord('child', 'ws-frame', 'taken')
  ]);
  assert.equal(result.statusCode, 200);
  const importedParent = api.trafficLog.find(request => request.protocol === 'ws');
  const importedFrame = api.trafficLog.find(request => request.protocol === 'ws-frame');
  assert.notEqual(importedParent.id, 'taken');
  assert.equal(importedFrame.parentId, importedParent.id);

  const reconnected = rendererHarness(api.trafficLog);
  reconnected.context.expandTrafficRequest(importedParent);
  reconnected.context.filterTraffic();
  assert.deepEqual(Array.from(reconnected.context.filteredTrafficIds()), [
    'taken', importedParent.id, importedFrame.id
  ]);

  api.maxTrafficLog = 2;
  const harResult = await postJson(port, '/api/traffic/import-har', {
    log: {
      entries: [{
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 1,
        request: {
          method: 'GET', url: 'https://example.test/imported',
          httpVersion: 'HTTP/1.1', headers: []
        },
        response: {
          status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
          headers: [], content: { text: '' }
        }
      }]
    }
  });
  assert.equal(harResult.statusCode, 200);
  assert.equal(api.trafficLog.length, 2);
  assert.equal(api.trafficLog[0].id, importedParent.id);
  assert.equal(api.trafficLog[0].protocol, 'ws');
  assert.equal(api.trafficLog[1].protocol, 'https');
});

test('duplicate imported WebSocket parents remap frames by lifecycle', () => {
  for (const imported of [
    [
      { ...trafficRecord('duplicate', 'ws'), trafficLifecycleId: 'lifecycle-a' },
      { ...trafficRecord('frame-a', 'ws-frame', 'duplicate'), parentTrafficLifecycleId: 'lifecycle-a' },
      { ...trafficRecord('duplicate', 'wss'), trafficLifecycleId: 'lifecycle-b' },
      { ...trafficRecord('frame-b', 'ws-frame', 'duplicate'), parentTrafficLifecycleId: 'lifecycle-b' }
    ],
    [
      { ...trafficRecord('frame-b', 'ws-frame', 'duplicate'), parentTrafficLifecycleId: 'lifecycle-b' },
      { ...trafficRecord('duplicate', 'ws'), trafficLifecycleId: 'lifecycle-a' },
      { ...trafficRecord('frame-a', 'ws-frame', 'duplicate'), parentTrafficLifecycleId: 'lifecycle-a' },
      { ...trafficRecord('duplicate', 'wss'), trafficLifecycleId: 'lifecycle-b' }
    ]
  ]) {
    const api = new ApiServer({ mockRules: [] }, null, null);
    api._appendImportedTraffic(imported);

    const parentA = api.trafficLog.find(request => request.trafficLifecycleId === 'lifecycle-a');
    const parentB = api.trafficLog.find(request => request.trafficLifecycleId === 'lifecycle-b');
    const frameA = api.trafficLog.find(request => request.id === 'frame-a');
    const frameB = api.trafficLog.find(request => request.id === 'frame-b');
    assert.equal(parentA.id, 'duplicate');
    assert.notEqual(parentB.id, parentA.id);
    assert.equal(frameA.parentId, parentA.id);
    assert.equal(frameB.parentId, parentB.id);

    const reconnected = rendererHarness(api.trafficLog);
    reconnected.context.expandTrafficRequest(parentA);
    reconnected.context.expandTrafficRequest(parentB);
    reconnected.context.filterTraffic();
    assert.deepEqual(Array.from(reconnected.context.filteredTrafficIds()), [
      parentA.id,
      frameA.id,
      parentB.id,
      frameB.id
    ]);
  }
});

test('legacy duplicate imported WebSocket parents bind frames to the first parent', () => {
  const api = new ApiServer({ mockRules: [] }, null, null);
  api._appendImportedTraffic([
    trafficRecord('legacy-frame', 'ws-frame', 'duplicate'),
    trafficRecord('duplicate', 'ws'),
    trafficRecord('duplicate', 'wss')
  ]);

  const parents = api.trafficLog.filter(request => request.protocol === 'ws' || request.protocol === 'wss');
  const frame = api.trafficLog.find(request => request.protocol === 'ws-frame');
  assert.equal(parents.length, 2);
  assert.notEqual(parents[0].id, parents[1].id);
  assert.equal(frame.parentId, parents[0].id);
});

test('legacy imported frames inherit the selected correlated parent lifecycle', () => {
  const scenarios = [
    {
      existing: [],
      imported: [
        trafficRecord('mixed-frame', 'ws-frame', 'mixed-parent'),
        { ...trafficRecord('mixed-parent', 'wss'), trafficLifecycleId: 'mixed-lifecycle' }
      ]
    },
    {
      existing: [trafficRecord('mixed-parent', 'https')],
      imported: [
        { ...trafficRecord('mixed-parent', 'ws'), trafficLifecycleId: 'mixed-lifecycle' },
        trafficRecord('mixed-frame', 'ws-frame', 'mixed-parent')
      ]
    },
    {
      existing: [],
      imported: [
        { ...trafficRecord('mixed-parent', 'ws'), trafficLifecycleId: 'mixed-lifecycle' },
        trafficRecord('mixed-parent', 'wss'),
        trafficRecord('mixed-frame', 'ws-frame', 'mixed-parent')
      ]
    },
    {
      existing: [{ ...trafficRecord('mixed-parent', 'wss'), trafficLifecycleId: 'mixed-lifecycle' }],
      imported: [trafficRecord('mixed-frame', 'ws-frame', 'mixed-parent')]
    }
  ];

  for (const { existing, imported } of scenarios) {
    const api = new ApiServer({ mockRules: [] }, null, null);
    api.maxTrafficLog = 3;
    api.trafficLog.push(...existing);
    api._appendImportedTraffic(imported);

    const parent = api.trafficLog.find(request => request.trafficLifecycleId === 'mixed-lifecycle');
    const frame = api.trafficLog.find(request => request.id === 'mixed-frame');
    assert.ok(parent);
    assert.equal(frame.parentId, parent.id);
    assert.equal(frame.parentTrafficLifecycleId, parent.trafficLifecycleId);

    const reconnected = rendererHarness(api.trafficLog);
    reconnected.context.expandTrafficRequest(parent);
    reconnected.context.filterTraffic();
    const visibleIds = Array.from(reconnected.context.filteredTrafficIds());
    assert.equal(visibleIds.indexOf(frame.id), visibleIds.indexOf(parent.id) + 1);
  }
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
  for (const [parentId, frameId] of [
    ['__proto__', 'proto-frame'],
    ['constructor', 'constructor-frame'],
    ['ordinary-parent', 'ordinary-frame']
  ]) {
    assert.deepEqual(
      Array.from(live.context.frameIdsForRequest({ id: parentId })),
      [frameId]
    );
  }

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

test('legacy IDs cannot collide with lifecycle WebSocket frame keys', () => {
  const correlatedParent = {
    ...trafficRecord('a', 'ws'),
    trafficLifecycleId: 'b'
  };
  const legacyParent = trafficRecord(JSON.stringify(['a', 'b']), 'wss');
  const correlatedFrame = {
    ...trafficRecord('correlated-frame', 'ws-frame', correlatedParent.id),
    parentTrafficLifecycleId: correlatedParent.trafficLifecycleId
  };
  const legacyFrame = trafficRecord('legacy-frame', 'ws-frame', legacyParent.id);
  const harness = rendererHarness([
    correlatedParent,
    correlatedFrame,
    legacyParent,
    legacyFrame
  ]);

  harness.context.filterTraffic();
  assert.deepEqual(Array.from(harness.context.filteredTrafficIds()), [
    correlatedParent.id,
    legacyParent.id
  ]);

  harness.context.toggleTraffic(correlatedParent.id, correlatedParent.trafficLifecycleId);
  assert.deepEqual(Array.from(harness.context.filteredTrafficIds()), [
    correlatedParent.id,
    correlatedFrame.id,
    legacyParent.id
  ]);

  harness.context.toggleTraffic(correlatedParent.id, correlatedParent.trafficLifecycleId);
  harness.context.toggleTraffic(legacyParent.id);
  assert.deepEqual(Array.from(harness.context.filteredTrafficIds()), [
    correlatedParent.id,
    legacyParent.id,
    legacyFrame.id
  ]);

  harness.context.toggleTraffic(correlatedParent.id, correlatedParent.trafficLifecycleId);

  assert.deepEqual(Array.from(harness.context.filteredTrafficIds()), [
    correlatedParent.id,
    correlatedFrame.id,
    legacyParent.id,
    legacyFrame.id
  ]);
  assert.deepEqual(Array.from(harness.context.frameIdsForRequest(correlatedParent)), [correlatedFrame.id]);
  assert.deepEqual(Array.from(harness.context.frameIdsForRequest(legacyParent)), [legacyFrame.id]);
});

test('secure WebSocket parents expose their frame rows and WebSocket styling', () => {
  const parent = {
    ...trafficRecord('secure-socket', 'wss'),
    trafficLifecycleId: 'secure-lifecycle'
  };
  const frame = {
    ...trafficRecord('secure-frame', 'ws-frame', parent.id),
    parentTrafficLifecycleId: parent.trafficLifecycleId
  };
  const harness = rendererHarness([parent, frame]);

  harness.context.expandTrafficRequest(parent);
  harness.context.filterTraffic();

  assert.deepEqual(Array.from(harness.context.filteredTrafficIds()), [
    parent.id,
    frame.id
  ]);
  const html = harness.context.trafficRowHtml(parent.id);
  assert.match(html, /method-badge method-WS">WS</);
  assert.match(html, /status-badge status-2xx/);
  assert.match(html, /ws-frame-count">1</);
  assert.match(html, /toggleWsExpand\('secure-socket','secure-lifecycle'\)/);
  assert.match(
    rendererSource,
    /\/\/ ---- WebSocket Card ----\s+if \(isConnectedWebSocket\(req\)\)/
  );
});

test('WebSocket rows preserve pending and failure status semantics', () => {
  for (const protocol of ['ws', 'wss']) {
    for (const { statusCode, error, expected } of [
      { statusCode: null, expected: /status-badge status-pending/ },
      { statusCode: 0, expected: /status-badge status-err">ERR/ },
      { statusCode: 0, error: 'downstream disconnected', expected: /status-badge status-err">ERR/ },
      { statusCode: 401, expected: /status-badge status-4xx">401/ },
      { statusCode: 502, error: 'upstream failed', expected: /status-badge status-err">502/ },
      { statusCode: 101, error: 'relay failed', expected: /status-badge status-err">101/ },
      { statusCode: 101, expected: /status-badge status-2xx">101/ }
    ]) {
      const request = { ...trafficRecord(`${protocol}-${statusCode}`, protocol), statusCode, error };
      const harness = rendererHarness([request]);
      const html = harness.context.trafficRowHtml(request.id);
      assert.match(html, /method-badge method-WS">WS/);
      assert.match(html, expected);
    }
  }
});

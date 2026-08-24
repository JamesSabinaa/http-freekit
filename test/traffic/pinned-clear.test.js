import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';

function createApi(options = {}) {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null, options);
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

function requestHeaders(port, requestPath, { method = 'OPTIONS', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: requestPath, method, headers
    }, response => {
      response.resume();
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function requestJson(port, requestPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...headers,
        ...(encodedBody === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encodedBody)
        })
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

test('pin and Clear retain one authoritative lifecycle across API consumers and reloads', async t => {
  const api = createApi();
  api.trafficLog = [
    { id: 'shared', trafficLifecycleId: 'old', method: 'GET', host: 'pinned.test' },
    { id: 'shared', trafficLifecycleId: 'current', method: 'POST', host: 'removed.test' }
  ];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(structuredClone(message));
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const pinned = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=old',
    { method: 'PUT', body: { pinned: true } }
  );
  assert.match(pinned.body.trafficGeneration, /^[0-9a-f-]{36}$/i);
  const trafficGeneration = pinned.body.trafficGeneration;
  assert.deepEqual(pinned, {
    statusCode: 200,
    body: {
      success: true,
      requestId: 'shared',
      trafficLifecycleId: 'old',
      trafficGeneration,
      pinned: true,
      revision: 1
    }
  });

  const cleared = await requestJson(port, '/api/traffic/clear', { method: 'POST' });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.success, true);
  assert.equal(cleared.body.revision, 1);
  const retainedRequest = {
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    host: 'pinned.test',
    pinned: true,
    trafficGeneration
  };
  assert.deepEqual(cleared.body.retainedTraffic, [retainedRequest]);
  assert.deepEqual(api.trafficLog, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    host: 'pinned.test',
    pinned: true
  }]);

  const detail = await requestJson(port, '/api/traffic/shared');
  assert.equal(detail.body.pinned, true);
  const search = await requestJson(port, '/api/traffic/search?host=pinned.test');
  assert.equal(search.body.total, 1);
  const exported = await requestJson(port, '/api/traffic/export');
  assert.deepEqual(exported.body.requests, api.trafficLog);
  assert.deepEqual(broadcasts, [
    {
      type: 'traffic-pinned',
      requestId: 'shared',
      trafficLifecycleId: 'old',
      trafficGeneration,
      pinned: true,
      revision: 1
    },
    {
      type: 'traffic-cleared',
      clearId: cleared.body.clearId,
      revision: 1,
      pinRevision: 1,
      retainedTraffic: [retainedRequest]
    }
  ]);
});

test('pin mutations reject ambiguous identities and invalid state without changing traffic', async t => {
  const api = createApi();
  api.trafficLog = [
    { id: 'shared', trafficLifecycleId: 'first' },
    { id: 'shared', trafficLifecycleId: 'second' }
  ];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const ambiguous = await requestJson(port, '/api/traffic/shared/pin', {
    method: 'PUT',
    body: { pinned: true }
  });
  assert.equal(ambiguous.statusCode, 409);
  assert.match(ambiguous.body.error, /provide trafficLifecycleId/);
  const ambiguousDetail = await requestJson(port, '/api/traffic/shared');
  assert.equal(ambiguousDetail.statusCode, 409);
  const exactDetail = await requestJson(port, '/api/traffic/shared?trafficLifecycleId=first');
  assert.equal(exactDetail.statusCode, 200);
  assert.equal(exactDetail.body.trafficLifecycleId, 'first');

  const invalid = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=first',
    { method: 'PUT', body: { pinned: 'yes' } }
  );
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(api.trafficLog, [
    { id: 'shared', trafficLifecycleId: 'first' },
    { id: 'shared', trafficLifecycleId: 'second' }
  ]);
  assert.deepEqual(broadcasts, []);
});

test('detail and Pin reject duplicate or nested lifecycle query values before mutation', async t => {
  const api = createApi();
  api.trafficLog = [{ id: 'shared', trafficLifecycleId: 'first' }];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  for (const query of [
    'trafficLifecycleId=first&trafficLifecycleId=first',
    'trafficLifecycleId%5Bnested%5D=first'
  ]) {
    const detail = await requestJson(port, `/api/traffic/shared?${query}`);
    const pin = await requestJson(port, `/api/traffic/shared/pin?${query}`, {
      method: 'PUT',
      body: { pinned: true }
    });
    assert.equal(detail.statusCode, 400);
    assert.equal(pin.statusCode, 400);
  }
  assert.equal(api.trafficLog[0].pinned, undefined);
  assert.deepEqual(broadcasts, []);
});

test('stale traffic session preconditions reject detail, Pin, and Clear before mutation', async t => {
  const api = createApi();
  api.trafficLog = [{ id: 'shared', trafficLifecycleId: 'life-1' }];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const staleHeaders = { 'x-http-freekit-traffic-session': 'stale-session' };

  const detail = await requestJson(
    port,
    '/api/traffic/shared?trafficLifecycleId=life-1',
    { headers: staleHeaders }
  );
  const pin = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=life-1',
    { method: 'PUT', body: { pinned: true }, headers: staleHeaders }
  );
  const clear = await requestJson(
    port,
    '/api/traffic/clear',
    { method: 'POST', headers: staleHeaders }
  );

  assert.deepEqual([detail.statusCode, pin.statusCode, clear.statusCode], [409, 409, 409]);
  assert.deepEqual(api.trafficLog, [{ id: 'shared', trafficLifecycleId: 'life-1' }]);
  assert.equal(api._trafficClearRevision, 0);
  assert.equal(api._trafficPinRevision, 0);
  assert.deepEqual(broadcasts, []);
});

test('stale server generations cannot read, Pin, or Delete an exactly reused exchange', async t => {
  const api = createApi();
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(structuredClone(message));
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const preflight = await requestHeaders(port, '/api/traffic/shared-life', {
    headers: {
      'access-control-request-headers':
        'x-http-freekit-traffic-session,x-http-freekit-traffic-generation'
    }
  });
  assert.equal(preflight.statusCode, 204);
  assert.match(
    preflight.headers['access-control-allow-headers'],
    /X-HTTP-FreeKit-Traffic-Generation/
  );

  for (const [id, trafficLifecycleId] of [
    ['shared-life', 'life-1'],
    ['shared-null', null]
  ]) {
    const query = trafficLifecycleId === null
      ? '?trafficLifecycleId='
      : '?trafficLifecycleId=' + encodeURIComponent(trafficLifecycleId);
    api.trafficLog = [{ id, trafficLifecycleId, method: 'GET', marker: 'A' }];

    const firstDetail = await requestJson(port, `/api/traffic/${id}${query}`);
    assert.equal(firstDetail.statusCode, 200);
    assert.match(firstDetail.body.trafficGeneration, /^[0-9a-f-]{36}$/i);
    const firstGeneration = firstDetail.body.trafficGeneration;

    // Omitting both private precondition headers remains the legacy API contract.
    const legacyDelete = await requestJson(port, `/api/traffic/${id}${query}`, {
      method: 'DELETE'
    });
    assert.equal(legacyDelete.statusCode, 200);
    const imported = await requestJson(port, '/api/traffic/import', {
      method: 'POST',
      body: {
        requests: [{
          id,
          trafficLifecycleId,
          trafficGeneration: firstGeneration,
          method: 'POST',
          url: 'https://replacement.test/',
          timestamp: new Date().toISOString(),
          marker: 'B'
        }]
      }
    });
    assert.equal(imported.statusCode, 200, JSON.stringify(imported.body));
    const replacement = api.trafficLog.find(request => request.id === id);
    assert.ok(replacement);
    assert.equal(replacement.marker, 'B');
    assert.equal(Object.hasOwn(replacement, 'trafficGeneration'), false);

    const replacementDetail = await requestJson(port, `/api/traffic/${id}${query}`);
    assert.equal(replacementDetail.statusCode, 200);
    const replacementGeneration = replacementDetail.body.trafficGeneration;
    assert.match(replacementGeneration, /^[0-9a-f-]{36}$/i);
    assert.notEqual(replacementGeneration, firstGeneration);

    broadcasts.length = 0;
    const pinRevision = api._trafficPinRevision;
    const deletionBookkeeping = structuredClone([...api._deletedTrafficIdentities]);
    const staleHeaders = {
      'x-http-freekit-traffic-session': api.captureStateSessionId,
      'x-http-freekit-traffic-generation': firstGeneration
    };
    const staleDetail = await requestJson(port, `/api/traffic/${id}${query}`, {
      headers: staleHeaders
    });
    const stalePin = await requestJson(port, `/api/traffic/${id}/pin${query}`, {
      method: 'PUT', body: { pinned: true }, headers: staleHeaders
    });
    const staleDelete = await requestJson(port, `/api/traffic/${id}${query}`, {
      method: 'DELETE', headers: staleHeaders
    });

    assert.deepEqual(
      [staleDetail.statusCode, stalePin.statusCode, staleDelete.statusCode],
      [409, 409, 409]
    );
    assert.equal(api.trafficLog.find(request => request.id === id), replacement);
    assert.equal(replacement.pinned, undefined);
    assert.equal(api._trafficPinRevision, pinRevision);
    assert.deepEqual([...api._deletedTrafficIdentities], deletionBookkeeping);
    assert.deepEqual(broadcasts, []);

    const sessionOnly = await requestJson(port, `/api/traffic/${id}${query}`, {
      headers: { 'x-http-freekit-traffic-session': api.captureStateSessionId }
    });
    const malformed = await requestJson(port, `/api/traffic/${id}${query}`, {
      headers: {
        'x-http-freekit-traffic-session': api.captureStateSessionId,
        'x-http-freekit-traffic-generation': 'not-a-generation'
      }
    });
    const duplicated = await requestJson(port, `/api/traffic/${id}${query}`, {
      headers: {
        'x-http-freekit-traffic-session': api.captureStateSessionId,
        'x-http-freekit-traffic-generation': [replacementGeneration, replacementGeneration]
      }
    });
    assert.deepEqual(
      [sessionOnly.statusCode, malformed.statusCode, duplicated.statusCode],
      [409, 400, 400]
    );
    assert.equal(api.trafficLog.find(request => request.id === id), replacement);
    assert.deepEqual(broadcasts, []);

    const currentHeaders = {
      'x-http-freekit-traffic-session': api.captureStateSessionId,
      'x-http-freekit-traffic-generation': replacementGeneration
    };
    const currentPin = await requestJson(port, `/api/traffic/${id}/pin${query}`, {
      method: 'PUT', body: { pinned: true }, headers: currentHeaders
    });
    assert.equal(currentPin.statusCode, 200);
    assert.equal(currentPin.body.trafficGeneration, replacementGeneration);
    assert.equal(replacement.pinned, true);
    const currentDelete = await requestJson(port, `/api/traffic/${id}${query}`, {
      method: 'DELETE', headers: currentHeaders
    });
    assert.equal(currentDelete.statusCode, 200);
    assert.equal(currentDelete.body.trafficGeneration, replacementGeneration);
    assert.equal(api.trafficLog.some(request => request.id === id), false);
    assert.deepEqual(broadcasts.map(message => message.type), [
      'traffic-pinned',
      'traffic-deleted'
    ]);
    assert.ok(broadcasts.every(message =>
      message.trafficGeneration === replacementGeneration
    ));
  }
});

test('an empty lifecycle query pins only the exact legacy-null generation', async t => {
  const api = createApi();
  const replacement = { id: 'shared', trafficLifecycleId: 'life-2' };
  api.trafficLog = [replacement];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const stalePin = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=',
    { method: 'PUT', body: { pinned: true } }
  );
  assert.equal(stalePin.statusCode, 404);
  assert.equal(replacement.pinned, undefined);
  assert.deepEqual(broadcasts, []);

  const legacy = { id: 'shared', trafficLifecycleId: null };
  api.trafficLog.unshift(legacy);
  const exactDetail = await requestJson(port, '/api/traffic/shared?trafficLifecycleId=');
  assert.equal(exactDetail.statusCode, 200);
  assert.equal(exactDetail.body.trafficLifecycleId, null);

  const exactPin = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=',
    { method: 'PUT', body: { pinned: true } }
  );
  assert.equal(exactPin.statusCode, 200);
  assert.equal(exactPin.body.trafficLifecycleId, null);
  assert.equal(legacy.pinned, true);
  assert.equal(replacement.pinned, undefined);
});

test('Clear chunks retained snapshots without exceeding the WebSocket ceiling', async () => {
  const api = createApi();
  const retainedTraffic = [
    {
      id: 'one',
      trafficLifecycleId: 'one-life',
      protocol: 'http',
      responseBody: 'a'.repeat(700),
      pinned: true
    },
    {
      id: 'two',
      trafficLifecycleId: 'two-life',
      protocol: 'http',
      responseBody: 'b'.repeat(700),
      pinned: true
    }
  ];
  const renderedRetainedTraffic = retainedTraffic.map(request =>
    api._trafficRequestForRenderer(request)
  );
  const placeholderChunk = Number.MAX_SAFE_INTEGER;
  const sampleClearId = '00000000-0000-4000-8000-000000000000';
  api.maxWsBufferedBytes = Math.max(...renderedRetainedTraffic.map(request =>
    Buffer.byteLength(JSON.stringify(api._trafficClearBroadcastMessage(
      sampleClearId,
      [request],
      placeholderChunk,
      placeholderChunk,
      placeholderChunk
    )))
  )) + 8;
  assert.equal(api._messageFitsWsBuffer(api._trafficClearBroadcastMessage(
    sampleClearId,
    renderedRetainedTraffic,
    0,
    1
  )), false);

  const client = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    terminateCalls: 0,
    send(payload, callback) {
      this.sent.push(payload);
      callback();
    },
    terminate() { this.terminateCalls++; }
  };
  api.clients.add(client);
  api.trafficLog = retainedTraffic;
  const result = api._clearTraffic();
  for (let attempt = 0; attempt < 10 && client.sent.length < 2; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.deepEqual(
    result.retainedTraffic.map(({ trafficGeneration, ...request }) => request),
    retainedTraffic
  );
  assert.ok(result.retainedTraffic.every(request =>
    /^[0-9a-f-]{36}$/i.test(request.trafficGeneration)
  ));
  assert.equal(client.terminateCalls, 0);
  assert.equal(api.clients.has(client), true);
  assert.ok(client.sent.length > 1);
  assert.ok(client.sent.every(payload => Buffer.byteLength(payload) <= api.maxWsBufferedBytes));
  const messages = client.sent.map(payload => JSON.parse(payload));
  assert.ok(messages.every((message, index) =>
    message.type === 'traffic-cleared' &&
    message.clearId === result.clearId &&
    message.revision === result.revision &&
    message.chunkIndex === index &&
    message.chunkCount === messages.length
  ));
  assert.deepEqual(
    messages.flatMap(message => message.retainedTraffic),
    result.retainedTraffic
  );
});

test('Clear replaces an unbounded lifecycle fallback with a verified bounded identity', () => {
  const api = createApi({ maxWsBufferedBytes: 1024 });
  const messages = api._buildTrafficClearedMessages('bounded-clear', [{
    id: 'bounded-id',
    trafficLifecycleId: 'life'.repeat(1000),
    responseBody: 'body'.repeat(1000),
    pinned: true
  }], 1);

  assert.ok(messages.length > 0);
  assert.ok(messages.every(message => api._messageFitsWsBuffer(message)));
  const [fallback] = messages.flatMap(message => message.retainedTraffic);
  assert.deepEqual({ ...fallback, trafficGeneration: '<opaque>' }, {
    id: 'bounded-id',
    trafficGeneration: '<opaque>',
    pinned: true,
    _deferredTrafficDetail: true
  });
  assert.match(fallback.trafficGeneration, /^[0-9a-f-]{36}$/i);
});

test('import remaps oversized lifecycle IDs and keeps Clear clients and exact hydration usable', async t => {
  const api = createApi({ maxWsBufferedBytes: 1024 });
  const client = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    terminateCalls: 0,
    send(payload, callback) {
      this.sent.push(payload);
      callback();
    },
    terminate() { this.terminateCalls++; }
  };
  api.clients.add(client);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const originalLifecycleId = 'oversized-lifecycle-'.repeat(150);
  const timestamp = new Date().toISOString();

  const imported = await requestJson(port, '/api/traffic/import', {
    method: 'POST',
    body: {
      requests: [
        {
          id: 'socket',
          trafficLifecycleId: originalLifecycleId,
          protocol: 'ws',
          timestamp,
          pinned: true
        },
        {
          id: 'frame',
          trafficLifecycleId: originalLifecycleId,
          protocol: 'ws-frame',
          parentId: 'socket',
          parentTrafficLifecycleId: originalLifecycleId,
          timestamp
        }
      ]
    }
  });
  assert.equal(imported.statusCode, 200);
  const parent = api.trafficLog.find(request => request.id === 'socket');
  const frame = api.trafficLog.find(request => request.id === 'frame');
  assert.notEqual(parent.trafficLifecycleId, originalLifecycleId);
  assert.ok(encodeURIComponent(parent.trafficLifecycleId).length <= 4096);
  assert.equal(frame.parentTrafficLifecycleId, parent.trafficLifecycleId);
  assert.notEqual(frame.trafficLifecycleId, originalLifecycleId);

  const result = api._clearTraffic();
  for (let attempt = 0; attempt < 20; attempt++) {
    const hasClear = client.sent.some(payload => JSON.parse(payload).type === 'traffic-cleared');
    if (hasClear) break;
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(client.terminateCalls, 0);
  assert.ok(client.sent.every(payload => Buffer.byteLength(payload) <= api.maxWsBufferedBytes));
  const clearMessages = client.sent.map(payload => JSON.parse(payload))
    .filter(message => message.type === 'traffic-cleared');
  assert.ok(clearMessages.length > 0);
  assert.equal(result.retainedTraffic[0].trafficLifecycleId, parent.trafficLifecycleId);
  const exactDetail = await requestJson(
    port,
    '/api/traffic/socket?trafficLifecycleId=' + encodeURIComponent(parent.trafficLifecycleId)
  );
  assert.equal(exactDetail.statusCode, 200);
  assert.equal(exactDetail.body.trafficLifecycleId, parent.trafficLifecycleId);
});

test('import remaps request IDs that cannot fit exact management routes', async t => {
  const api = createApi();
  api._broadcast = () => {};
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const originalId = 'oversized-request-id-'.repeat(1000);

  const imported = await requestJson(port, '/api/traffic/import', {
    method: 'POST',
    body: {
      requests: [{
        id: originalId,
        trafficLifecycleId: 'imported-life',
        method: 'GET',
        url: 'https://example.test/',
        timestamp: new Date().toISOString()
      }]
    }
  });
  assert.equal(imported.statusCode, 200);
  const assigned = api.trafficLog[0];
  assert.notEqual(assigned.id, originalId);
  assert.ok(Buffer.byteLength(encodeURIComponent(assigned.id)) <= 4096);

  const detail = await requestJson(
    port,
    '/api/traffic/' + encodeURIComponent(assigned.id) +
      '?trafficLifecycleId=' + encodeURIComponent(assigned.trafficLifecycleId)
  );
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.id, assigned.id);
  const pinned = await requestJson(
    port,
    '/api/traffic/' + encodeURIComponent(assigned.id) +
      '/pin?trafficLifecycleId=' + encodeURIComponent(assigned.trafficLifecycleId),
    { method: 'PUT', body: { pinned: true } }
  );
  assert.equal(pinned.statusCode, 200);
  assert.equal(pinned.body.pinned, true);
});

test('tight Clear messages keep duplicate IDs exact with compact deferred lifecycles', () => {
  const api = createApi({ maxWsBufferedBytes: 320 });
  const retainedTraffic = [
    {
      id: 'shared',
      trafficLifecycleId: '00000000-0000-4000-8000-000000000001',
      responseBody: 'a'.repeat(1000),
      pinned: true
    },
    {
      id: 'shared',
      trafficLifecycleId: '00000000-0000-4000-8000-000000000002',
      responseBody: 'b'.repeat(1000),
      pinned: true
    }
  ];
  const messages = api._buildTrafficClearedMessages(
    '00000000-0000-4000-8000-000000000000',
    retainedTraffic,
    1,
    0
  );

  assert.ok(messages.length > 0);
  assert.ok(messages.every(message => message.d === 1 && message.p === 0));
  assert.ok(messages.every(message => api._messageFitsWsBuffer(message)));
  const compactRows = messages.flatMap(message => message.retainedTraffic);
  assert.deepEqual(compactRows.map(({ g, ...request }) => request), [
    { id: 'shared', l: retainedTraffic[0].trafficLifecycleId },
    { id: 'shared', l: retainedTraffic[1].trafficLifecycleId }
  ]);
  assert.ok(compactRows.every(request => /^[0-9a-f-]{36}$/i.test(request.g)));
});

test('WebSocket frames cannot become independently pinned or import invalid pin state', async t => {
  const api = createApi();
  api.trafficLog = [{
    id: 'frame',
    trafficLifecycleId: 'frame-life',
    parentId: 'socket',
    protocol: 'ws-frame'
  }];
  api._broadcast = () => {};
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const pin = await requestJson(port, '/api/traffic/frame/pin?trafficLifecycleId=frame-life', {
    method: 'PUT',
    body: { pinned: true }
  });
  assert.equal(pin.statusCode, 400);
  assert.match(pin.body.error, /pin the parent connection/);
  assert.equal(api.trafficLog[0].pinned, undefined);

  const invalidBoolean = api._getTrafficImportValidationError([{
    id: 'imported',
    timestamp: Date.now(),
    pinned: 'yes'
  }]);
  assert.equal(invalidBoolean, 'requests[0].pinned must be a boolean');
  const pinnedFrame = api._getTrafficImportValidationError([{
    id: 'imported-frame',
    parentId: 'socket',
    protocol: 'ws-frame',
    timestamp: Date.now(),
    pinned: true
  }]);
  assert.equal(pinnedFrame, 'requests[0].pinned cannot be true for WebSocket frames');
});

test('unpinning makes a previously retained exchange eligible for the next Clear', async t => {
  const api = createApi();
  api.trafficLog = [{ id: 'kept', trafficLifecycleId: 'life', pinned: true }];
  api._broadcast = () => {};
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const unpinned = await requestJson(port, '/api/traffic/kept/pin?trafficLifecycleId=life', {
    method: 'PUT',
    body: { pinned: false }
  });
  assert.equal(unpinned.statusCode, 200);
  const cleared = await requestJson(port, '/api/traffic/clear', { method: 'POST' });

  assert.deepEqual(cleared.body.retainedTraffic, []);
  assert.deepEqual(api.trafficLog, []);
});

test('a pinned pending lifecycle can complete after repeated Clear operations', () => {
  const api = createApi();
  const broadcasts = [];
  const lifecycleToken = Symbol('pending');
  const pending = {
    id: 'slow',
    trafficLifecycleId: 'slow-life',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    method: 'GET'
  };
  api._broadcast = message => broadcasts.push(structuredClone(message));
  api.onTrafficEvent(pending);
  const generation = pending._trafficClearGeneration;
  const trafficGeneration = broadcasts[0].data.trafficGeneration;
  assert.match(trafficGeneration, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(api.trafficLog[0], 'trafficGeneration'), false);
  assert.equal(
    api._buildTrafficDumpMessages(api.trafficLog)[0].requests[0].trafficGeneration,
    trafficGeneration
  );
  api.trafficLog[0].pinned = true;

  const firstClear = api._clearTraffic();
  assert.equal(firstClear.retainedTraffic[0].trafficGeneration, trafficGeneration);
  api._clearTraffic();
  api.onTrafficEvent({
    id: 'slow',
    trafficLifecycleId: 'slow-life',
    _trafficLifecycleToken: lifecycleToken,
    _trafficClearGeneration: generation,
    _update: true,
    method: 'GET',
    statusCode: 200
  });

  assert.deepEqual(api.trafficLog, [{
    id: 'slow',
    trafficLifecycleId: 'slow-life',
    method: 'GET',
    statusCode: 200,
    pinned: true
  }]);
  assert.equal(api._pendingTrafficIds.size, 0);
  assert.equal(api._pendingTrafficLifecycles.size, 0);
  assert.equal(api._retainedTrafficGenerations.size, 0);
  assert.equal(broadcasts.at(-1).type, 'request-update');
  assert.equal(broadcasts.at(-1).data.trafficGeneration, trafficGeneration);
  assert.equal(Object.hasOwn(api.trafficLog[0], 'trafficGeneration'), false);
});

test('a pinned WebSocket keeps post-Clear frames without growing generation history', () => {
  const api = createApi();
  const lifecycleToken = Symbol('socket');
  const socket = {
    id: 'socket',
    trafficLifecycleId: 'socket-life',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    protocol: 'ws'
  };
  api._broadcast = () => {};
  api.onTrafficEvent(socket);
  const originalGeneration = socket._trafficClearGeneration;
  api.trafficLog[0].pinned = true;

  api._clearTraffic();
  api._clearTraffic();
  api._clearTraffic();

  const retainedGenerations = api._retainedTrafficGenerations.get(
    api._trafficIdentityKey('socket', 'socket-life')
  );
  assert.equal(retainedGenerations.size, 1);
  assert.equal(retainedGenerations.has(originalGeneration), true);

  api.onTrafficEvent({
    id: 'frame',
    trafficLifecycleId: 'frame-life',
    parentId: 'socket',
    parentTrafficLifecycleId: 'socket-life',
    _trafficClearGeneration: originalGeneration,
    protocol: 'ws-frame',
    requestBody: 'hello'
  });

  assert.deepEqual(api.trafficLog.map(request => request.id), ['socket', 'frame']);
  assert.equal(api.trafficLog[1].requestBody, 'hello');
});

test('a deleted retained lifecycle expires after its old-generation completion', async t => {
  let now = 0;
  const api = createApi({
    clearedPendingTrafficTtlMs: 5,
    clearedPendingTrafficNow: () => now
  });
  const lifecycleToken = Symbol('socket');
  const socket = {
    id: 'socket',
    trafficLifecycleId: 'socket-life',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    protocol: 'wss'
  };
  api._broadcast = () => {};
  api.onTrafficEvent(socket);
  const originalGeneration = socket._trafficClearGeneration;
  api.trafficLog[0].pinned = true;
  api._clearTraffic();

  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const deleted = await requestJson(
    port,
    '/api/traffic/socket?trafficLifecycleId=socket-life',
    { method: 'DELETE' }
  );
  assert.equal(deleted.statusCode, 200);
  const identityKey = api._trafficIdentityKey('socket', 'socket-life');
  assert.equal(api._deletedTrafficIdentities.get(identityKey), Infinity);

  api.onTrafficEvent({
    id: 'socket',
    trafficLifecycleId: 'socket-life',
    _trafficLifecycleToken: lifecycleToken,
    _trafficClearGeneration: originalGeneration,
    _update: true,
    protocol: 'wss',
    statusCode: 101
  });

  assert.equal(api._deletedTrafficIdentities.get(identityKey), 5);
  now = 6;
  api._pruneDeletedTrafficIdentities();
  assert.equal(api._deletedTrafficIdentities.has(identityKey), false);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const identityStart = rendererSource.indexOf('function normalizeTrafficLifecycleId(');
const identityEnd = rendererSource.indexOf('function isSelectedTrafficRequest(', identityStart);
const mergeStart = rendererSource.indexOf('function mergeServerTrafficRequest(');
const mergeEnd = rendererSource.indexOf('function mergeTrafficDumpPins(', mergeStart);
const stateStart = rendererSource.indexOf('const appliedTrafficClearIds = new Set();');
const stateEnd = rendererSource.indexOf('function connectWebSocket()', stateStart);
const actionStart = rendererSource.indexOf('const trafficPinInFlight = new Set();');
const actionEnd = rendererSource.indexOf('function updatePinIcon(', actionStart);
const hydrationStart = rendererSource.indexOf('const deferredTrafficHydrations = new Map();');
const hydrationEnd = rendererSource.indexOf('function selectBreakpointRequest(', hydrationStart);
assert.notEqual(identityStart, -1);
assert.notEqual(identityEnd, -1);
assert.notEqual(mergeStart, -1);
assert.notEqual(mergeEnd, -1);
assert.notEqual(stateStart, -1);
assert.notEqual(stateEnd, -1);
assert.notEqual(actionStart, -1);
assert.notEqual(actionEnd, -1);
assert.notEqual(hydrationStart, -1);
assert.notEqual(hydrationEnd, -1);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function rendererResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function createRenderer(fetch) {
  const toasts = [];
  const fetchCalls = [];
  let renders = 0;
  const shownDetails = [];
  const hydratedDetails = [];
  const pinIcons = [];
  const context = {
    API_BASE: '',
    encodeURIComponent,
    fetch: async (...args) => {
      fetchCalls.push(args);
      const response = await fetch(...args);
      const trafficGeneration = args[1]?.headers?.['X-HTTP-FreeKit-Traffic-Generation'];
      return {
        ...response,
        json: async () => {
          const body = await response.json();
          return body && typeof body === 'object' &&
              body.trafficGeneration === undefined && trafficGeneration
            ? { ...body, trafficGeneration }
            : body;
        }
      };
    },
    toast: (message, type) => toasts.push({ message, type }),
    document: { getElementById: () => null },
    renderTraffic: () => { renders++; },
    showDetail: request => {
      const { trafficGeneration: _trafficGeneration, ...snapshot } = request;
      shownDetails.push(structuredClone(snapshot));
    },
    hydrateDeferredTrafficRequest: request => {
      const { trafficGeneration: _trafficGeneration, ...snapshot } = request;
      hydratedDetails.push(structuredClone(snapshot));
    },
    renderSelectedTrafficDetail: request => {
      if (request?._deferredTrafficDetail === true) {
        return context.hydrateDeferredTrafficRequest(request);
      }
      context.showDetail(request);
      return Promise.resolve(request);
    },
    updatePinIcon: pinned => pinIcons.push(pinned),
    applyFilter: () => {},
    closeDetail: () => {},
    isWebSocketConnection: () => false,
    wsExpandedConnections: new Set(),
    wsConnectionKey: () => ''
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [
      {
        id: 'shared', trafficLifecycleId: 'old',
        trafficGeneration: '00000000-0000-4000-8000-000000000001'
      },
      {
        id: 'shared', trafficLifecycleId: 'current',
        trafficGeneration: '00000000-0000-4000-8000-000000000002'
      }
    ];
    let selectedRequestId = 'shared';
    let selectedRequestLifecycleId = 'old';
    let captureStateSessionId = 'session-a';
    let trafficConnectionEpoch = 0;
    let trafficDumpReady = true;
    let requestCounter = requests.length;
    let vsRenderStart = 0;
    let vsRenderEnd = 0;
    ${rendererSource.slice(identityStart, identityEnd)}
    ${rendererSource.slice(mergeStart, mergeEnd)}
    function isSelectedTrafficRequest(request) {
      return selectedRequestId !== null && trafficRequestMatchesIdentity(
        request,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }
    function getSelectedTrafficRequest(collection = requests) {
      return findTrafficRequestByIdentity(
        collection,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }
    ${rendererSource.slice(stateStart, stateEnd)}
    function trafficActionRequest(requestId = selectedRequestId, trafficLifecycleId) {
      const resolvedLifecycleId = trafficLifecycleId === undefined && requestId === selectedRequestId
        ? selectedRequestLifecycleId
        : trafficLifecycleId;
      return findTrafficRequestByIdentity(requests, requestId, resolvedLifecycleId);
    }
    function restoreTrafficDump(serverRequests) {
      requests = serverRequests.map((request, index) => ({
        trafficGeneration: request.trafficGeneration || 'dump-generation-' + index,
        ...request
      }));
      requestCounter = requests.length;
      applyFilter();
    }
    ${rendererSource.slice(actionStart, actionEnd)}
    globalThis.snapshot = () => ({
      requests: requests.map(({ trafficGeneration, ...request }) => request),
      selectedRequestId,
      selectedRequestLifecycleId,
      trafficConnectionEpoch,
      trafficDumpReady,
      inFlight: trafficPinInFlight.size
    });
    let testGenerationCounter = 10;
    globalThis.setRequests = value => {
      requests = value.map(request => {
        if (!request.trafficGeneration) {
          request.trafficGeneration = 'test-generation-' + testGenerationCounter++;
        }
        return request;
      });
    };
    globalThis.setSelection = (requestId, lifecycleId) => {
      selectedRequestId = requestId;
      selectedRequestLifecycleId = lifecycleId;
    };
    globalThis.setTrafficSession = value => { captureStateSessionId = value; };
    globalThis.requestAt = index => requests[index];
    globalThis.serverGenerationAt = index => requests[index]?.trafficGeneration;
    globalThis.authorizeRequestUpdateAt = (index, value) => {
      requests[index] = mergeTrafficRequestUpdate(requests[index], value);
      return requests[index];
    };
    globalThis.captureGenerationAt = index => ensureTrafficGenerationToken(requests[index]);
    globalThis.hasGenerationAt = (index, generation) =>
      deferredTrafficGenerationTokens.get(requests[index]) === generation;
  `, context);
  return {
    context,
    fetchCalls,
    toasts,
    pinIcons,
    shownDetails,
    hydratedDetails,
    installDeferredHydration() {
      vm.runInContext(rendererSource.slice(hydrationStart, hydrationEnd), context);
    },
    get renders() { return renders; },
    snapshot() {
      return JSON.parse(JSON.stringify(context.snapshot()));
    }
  };
}

test('renderer pins only after authoritative confirmation and applies broadcast/response once', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  const pinning = renderer.context.togglePinRequest();

  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  renderer.context.applyTrafficPinned('shared', 'old', true, 1);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.equal(renderer.fetchCalls[0][0], '/api/traffic/shared/pin?trafficLifecycleId=old');
  assert.equal(renderer.fetchCalls[0][1].method, 'PUT');
  assert.equal(
    renderer.fetchCalls[0][1].headers['X-HTTP-FreeKit-Traffic-Session'],
    'session-a'
  );
  assert.deepEqual(JSON.parse(renderer.fetchCalls[0][1].body), { pinned: true });
  assert.equal(renderer.snapshot().requests[0].pinned, true);
  assert.equal(renderer.snapshot().requests[1].pinned, undefined);
  assert.equal(renderer.renders, 1);
  assert.deepEqual(renderer.pinIcons, [true]);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange pinned', type: 'success' }]);
  assert.equal(renderer.snapshot().inFlight, 0);

  renderer.context.applyTrafficPinned('shared', 'old', false, 0);
  assert.equal(renderer.snapshot().requests[0].pinned, true);
  renderer.context.applyTrafficCleared('clear-one', [
    { id: 'shared', trafficLifecycleId: 'old' }
  ]);
  assert.deepEqual(renderer.snapshot().requests, [
    { id: 'shared', trafficLifecycleId: 'old', pinned: true }
  ]);
});

test('a rejected pin response consumes its late event before a reused identity', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL'
  }]);
  renderer.context.setSelection('shared', 'old');
  const pinning = renderer.context.togglePinRequest();

  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT'
  }]);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT'
  }]);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to update pin: The exchange changed while the pin update was pending.',
    type: 'error'
  }]);
  assert.equal(renderer.snapshot().inFlight, 0);

  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), false);
  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 2), true);
  assert.equal(renderer.snapshot().requests[0].pinned, true);
});

test('an old-session pin response cannot poison a newly reset renderer session', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'CURRENT'
  }]);
  renderer.context.setSelection('shared', 'old');
  const pinning = renderer.context.togglePinRequest();

  renderer.context.setTrafficSession('session-b');
  assert.equal(
    renderer.context.applyTrafficServerSessionBoundary('session-a', 'session-b'),
    true
  );
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'NEW-SESSION'
  }]);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 99
  }));
  await pinning;

  assert.equal(renderer.snapshot().requests[0].method, 'NEW-SESSION');
  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  assert.match(renderer.toasts.at(-1).message, /server session changed/i);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), true);
});

test('a rejected pin response and late event leave duplicate identities untouched', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL'
  }]);
  renderer.context.setSelection('shared', 'old');
  const original = renderer.context.requestAt(0);
  const pinning = renderer.context.togglePinRequest();
  renderer.context.setRequests([
    original,
    { id: 'shared', trafficLifecycleId: 'old', method: 'DUPLICATE' }
  ]);

  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), false);
  assert.equal(renderer.snapshot().requests.some(request => request.pinned), false);
  assert.match(renderer.toasts.at(-1).message, /exchange changed/i);
});

test('renderer applies a pending pin broadcast after an authorized generation transfer', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL'
  }]);
  renderer.context.setSelection('shared', 'old');
  const pinning = renderer.context.togglePinRequest();
  renderer.context.authorizeRequestUpdateAt(0, {
    id: 'shared', trafficLifecycleId: 'old', method: 'UPDATED'
  });

  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), true);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'UPDATED', pinned: true
  }]);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange pinned', type: 'success' }]);
});

test('a Clear pin watermark retires stale local state before the HTTP response', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL', pinned: true
  }]);
  renderer.context.setSelection('shared', 'old');
  const unpinning = renderer.context.togglePinRequest();

  renderer.context.applyTrafficCleared('replacement-clear', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT', pinned: true
  }], 1, 1);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 1), false);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 2), true);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: false,
    revision: 1
  }));
  await unpinning;

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT'
  }]);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange unpinned', type: 'success' }]);
});

test('a Clear pin watermark protects replacement rows without a local mutation', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.applyTrafficCleared('replacement-clear', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT', pinned: true
  }], 1, 4);
  assert.equal(renderer.context.applyTrafficCleared('replacement-clear', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'IGNORED', pinned: true
  }], 1, 99), false);

  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 4), false);
  assert.equal(renderer.snapshot().requests[0].pinned, true);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 5), true);
  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
});

test('a new accepted server session resets every traffic ordering floor', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', pinned: true
  }]);
  assert.equal(renderer.context.applyTrafficCleared('old-clear', [{
    id: 'shared', trafficLifecycleId: 'old', pinned: true
  }], 9, 9, 'ws'), true);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 10), true);

  assert.equal(
    renderer.context.applyTrafficServerSessionBoundary('session-a', 'session-a'),
    false
  );
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), false);
  assert.equal(renderer.context.applyTrafficCleared('too-old', [{
    id: 'shared', trafficLifecycleId: 'old', pinned: true
  }], 1, 1, 'ws'), false);

  assert.equal(
    renderer.context.applyTrafficServerSessionBoundary('session-a', 'session-b'),
    true
  );
  assert.deepEqual(renderer.snapshot().requests, []);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old'
  }]);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), true);
  renderer.context.setRequests([{
    id: 'delete-me', trafficLifecycleId: 'life-1', protocol: 'http'
  }]);
  assert.equal(renderer.context.applyTrafficDeleted('delete-me', 'life-1', false, 0), true);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', pinned: true
  }]);
  assert.equal(renderer.context.applyTrafficCleared('new-clear', [{
    id: 'shared', trafficLifecycleId: 'old', pinned: true
  }], 1, 1, 'ws'), true);
});

test('a new server session clears selected traffic before its replacement dump', async () => {
  const renderer = createRenderer(() => assert.fail('pre-dump Pin must not fetch'));
  renderer.context.beginTrafficDumpSync();
  renderer.context.setTrafficSession('session-b');
  assert.equal(
    renderer.context.applyTrafficServerSessionBoundary('session-a', 'session-b'),
    true
  );

  await renderer.context.togglePinRequest();

  assert.deepEqual(renderer.snapshot().requests, []);
  assert.equal(renderer.snapshot().selectedRequestId, null);
  assert.equal(renderer.fetchCalls.length, 0);
});

test('accepted pin revisions allow identity reuse before the HTTP response', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL'
  }]);
  renderer.context.setSelection('shared', 'old');
  const pinning = renderer.context.togglePinRequest();

  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), true);
  renderer.context.applyTrafficCleared('replacement-clear', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT', pinned: true
  }], 1, 1);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 2), true);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT'
  }]);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange pinned', type: 'success' }]);
});

test('renderer encodes explicit-null pin identity and leaves an in-flight replacement untouched', async () => {
  let renderer;
  renderer = createRenderer(async () => {
    renderer.context.setRequests([{ id: 'shared', trafficLifecycleId: 'life-2' }]);
    renderer.context.setSelection('shared', 'life-2');
    return rendererResponse({ error: 'Request not found' }, { ok: false, status: 404 });
  });
  renderer.context.setRequests([{ id: 'shared', trafficLifecycleId: null }]);
  renderer.context.setSelection('shared', null);

  await renderer.context.togglePinRequest();

  assert.equal(renderer.fetchCalls[0][0], '/api/traffic/shared/pin?trafficLifecycleId=');
  assert.deepEqual(renderer.snapshot().requests, [
    { id: 'shared', trafficLifecycleId: 'life-2' }
  ]);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to update pin: Request not found',
    type: 'error'
  }]);
});

test('renderer replaces stale rows and restores missed retained rows from Clear', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.setRequests([
    { id: 'shared', trafficLifecycleId: 'old', method: 'GET', _pending: true },
    { id: 'removed', trafficLifecycleId: 'gone', method: 'DELETE' }
  ]);

  renderer.context.applyTrafficCleared('authoritative-clear', [
    {
      id: 'shared',
      trafficLifecycleId: 'old',
      method: 'GET',
      statusCode: 200,
      pinned: true
    },
    {
      id: 'missed',
      trafficLifecycleId: 'missed-life',
      method: 'POST',
      statusCode: 201,
      pinned: true
    }
  ]);

  assert.deepEqual(renderer.snapshot().requests, [
    {
      id: 'shared',
      trafficLifecycleId: 'old',
      method: 'GET',
      statusCode: 200,
      pinned: true
    },
    {
      id: 'missed',
      trafficLifecycleId: 'missed-life',
      method: 'POST',
      statusCode: 201,
      pinned: true
    }
  ]);
  assert.deepEqual(renderer.shownDetails, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    statusCode: 200,
    pinned: true
  }]);
});

test('renderer applies chunked Clear snapshots only after the final chunk', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const before = renderer.snapshot().requests;
  const firstApplied = renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'chunked-clear',
    chunkIndex: 0,
    chunkCount: 2,
    retainedTraffic: [{
      id: 'shared',
      trafficLifecycleId: 'old',
      method: 'GET',
      statusCode: 200,
      pinned: true
    }]
  });
  assert.equal(firstApplied, false);
  assert.deepEqual(renderer.snapshot().requests, before);

  const finalApplied = renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'chunked-clear',
    chunkIndex: 1,
    chunkCount: 2,
    retainedTraffic: [{
      id: 'missed',
      trafficLifecycleId: 'missed-life',
      method: 'POST',
      statusCode: 201,
      pinned: true
    }]
  });
  assert.equal(finalApplied, true);
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['shared', 'missed']);
});

test('a newer Clear response supersedes incomplete older chunks', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'older-clear',
    revision: 1,
    chunkIndex: 0,
    chunkCount: 2,
    retainedTraffic: [{ id: 'older-one', pinned: true }]
  });

  const newerApplied = renderer.context.applyTrafficCleared(
    'newer-clear',
    [{ id: 'newer', pinned: true }],
    2
  );
  const olderCompleted = renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'older-clear',
    revision: 1,
    chunkIndex: 1,
    chunkCount: 2,
    retainedTraffic: [{ id: 'older-two', pinned: true }]
  });

  assert.equal(newerApplied, true);
  assert.equal(olderCompleted, false);
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['newer']);
});

test('REST Clear completion upgrades a deferred WebSocket snapshot', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.applyTrafficCleared('large-clear', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    pinned: true,
    _deferredTrafficDetail: true
  }], undefined, undefined, 'ws');
  assert.equal(renderer.hydratedDetails.length, 1);

  const upgraded = renderer.context.applyTrafficCleared('large-clear', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body',
    pinned: true
  }], undefined, undefined, 'rest');

  assert.equal(upgraded, true);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body',
    pinned: true
  }]);
});

test('REST Clear upgrade rejects a compact generation deleted and reused by identity', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  assert.equal(renderer.context.applyTrafficCleared('compact-reuse', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'COMPACT',
    pinned: true,
    _deferredTrafficDetail: true
  }], 1, 0, 'ws'), true);
  const compactGeneration = renderer.context.captureGenerationAt(0);

  assert.equal(renderer.context.applyTrafficDeleted('shared', 'old', false, 1), true);
  renderer.context.setRequests([{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'REUSED',
    _deferredTrafficDetail: true
  }]);
  const reusedGeneration = renderer.context.captureGenerationAt(0);

  assert.equal(renderer.context.applyTrafficCleared('compact-reuse', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'STALE-FULL',
    responseBody: 'stale body',
    pinned: true
  }], 1, 0, 'rest'), true);

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'REUSED',
    _deferredTrafficDetail: true
  }]);
  assert.equal(renderer.context.hasGenerationAt(0, reusedGeneration), true);
  assert.equal(renderer.context.hasGenerationAt(0, compactGeneration), false);
  assert.equal(
    renderer.context.currentLatestTrafficClearRetainedRequest('shared', 'old'),
    null
  );
});

test('identity-only deferred Clear rows keep selection through full REST upgrade', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.setRequests([{
    id: 'oversized',
    trafficLifecycleId: 'original-life',
    pinned: true
  }]);
  renderer.context.setSelection('oversized', 'original-life');

  renderer.context.applyTrafficCleared('identity-clear', [{
    id: 'oversized',
    pinned: true,
    _deferredTrafficDetail: true
  }]);
  assert.equal(renderer.snapshot().selectedRequestLifecycleId, null);
  assert.equal(renderer.hydratedDetails.length, 1);

  renderer.context.applyTrafficCleared('identity-clear', [{
    id: 'oversized',
    trafficLifecycleId: 'remapped-life',
    method: 'GET',
    responseBody: 'complete',
    pinned: true
  }]);

  assert.equal(renderer.snapshot().selectedRequestLifecycleId, 'remapped-life');
  assert.deepEqual(renderer.shownDetails.at(-1), {
    id: 'oversized',
    trafficLifecycleId: 'remapped-life',
    method: 'GET',
    responseBody: 'complete',
    pinned: true
  });
});

test('compact deferred Clear rows preserve duplicate lifecycle identities', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const messages = [
    {
      type: 'traffic-cleared',
      clearId: 'compact-clear',
      revision: 1,
      p: 0,
      chunkIndex: 0,
      chunkCount: 2,
      d: 1,
      retainedTraffic: [{
        id: 'shared',
        g: '00000000-0000-4000-8000-0000000000a1',
        l: '00000000-0000-4000-8000-000000000001'
      }]
    },
    {
      type: 'traffic-cleared',
      clearId: 'compact-clear',
      revision: 1,
      p: 0,
      chunkIndex: 1,
      chunkCount: 2,
      d: 1,
      retainedTraffic: [{
        id: 'shared',
        g: '00000000-0000-4000-8000-0000000000a2',
        l: '00000000-0000-4000-8000-000000000002'
      }]
    }
  ];

  assert.equal(renderer.context.applyTrafficClearedMessage(messages[0]), false);
  assert.equal(renderer.context.applyTrafficClearedMessage(messages[1]), true);
  assert.deepEqual(renderer.snapshot().requests, [
    {
      id: 'shared',
      trafficLifecycleId: '00000000-0000-4000-8000-000000000001',
      pinned: true,
      _deferredTrafficDetail: true
    },
    {
      id: 'shared',
      trafficLifecycleId: '00000000-0000-4000-8000-000000000002',
      pinned: true,
      _deferredTrafficDetail: true
    }
  ]);
});

test('a pin mutation newer than a compact Clear survives chunk assembly', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const firstLifecycle = '00000000-0000-4000-8000-000000000001';
  const secondLifecycle = '00000000-0000-4000-8000-000000000002';
  renderer.context.setRequests([
    { id: 'shared', trafficLifecycleId: firstLifecycle, pinned: true },
    { id: 'shared', trafficLifecycleId: secondLifecycle, pinned: true }
  ]);
  const firstChunk = {
    type: 'traffic-cleared',
    clearId: 'compact-race',
    revision: 1,
    p: 8,
    chunkIndex: 0,
    chunkCount: 2,
    d: 1,
    retainedTraffic: [{
      id: 'shared',
      g: renderer.context.serverGenerationAt(0),
      l: firstLifecycle
    }]
  };
  const secondChunk = {
    ...firstChunk,
    chunkIndex: 1,
    retainedTraffic: [{
      id: 'shared',
      g: renderer.context.serverGenerationAt(1),
      l: secondLifecycle
    }]
  };

  assert.equal(renderer.context.applyTrafficClearedMessage(firstChunk), false);
  assert.equal(renderer.context.applyTrafficPinned('shared', firstLifecycle, false, 9), true);
  assert.equal(renderer.context.applyTrafficClearedMessage(secondChunk), true);
  assert.equal(renderer.context.applyTrafficPinned('shared', firstLifecycle, false, 9), false);
  assert.deepEqual(renderer.snapshot().requests, [
    { id: 'shared', trafficLifecycleId: firstLifecycle, _deferredTrafficDetail: true },
    {
      id: 'shared',
      trafficLifecycleId: secondLifecycle,
      pinned: true,
      _deferredTrafficDetail: true
    }
  ]);
});

test('deferred Clear upgrades preserve a later unpin mutation', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.applyTrafficCleared('large-clear', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    pinned: true,
    _deferredTrafficDetail: true
  }]);
  renderer.context.applyTrafficPinned('shared', 'old', false, 9);

  const upgraded = renderer.context.applyTrafficCleared('large-clear', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body',
    pinned: true
  }]);

  assert.equal(upgraded, true);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body'
  }]);
});

test('exact deferred hydration preserves pin mutations received while loading', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.installDeferredHydration();
  const deferredRequest = {
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    pinned: true,
    _deferredTrafficDetail: true
  };
  renderer.context.setRequests([deferredRequest]);

  const hydration = renderer.context.renderSelectedTrafficDetail(deferredRequest);
  renderer.context.applyTrafficPinned('shared', 'old', false, 10);
  pending.resolve(rendererResponse({
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body',
    pinned: true
  }));
  await hydration;

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body'
  }]);
  assert.deepEqual(renderer.shownDetails, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body'
  }]);
});

test('an ordinary retained Clear invalidates an older context generation', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'OLD', pinned: true
  }]);
  renderer.context.setSelection('shared', 'old');
  const generation = renderer.context.captureGenerationAt(0);
  renderer.context.applyTrafficPinned('shared', 'old', true, 2);

  renderer.context.applyTrafficCleared('new-clear', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT', pinned: true
  }], 1, 1);

  assert.equal(renderer.snapshot().requests[0].method, 'REPLACEMENT');
  assert.equal(renderer.context.hasGenerationAt(0, generation), false);
});

test('pending compact hydration survives the matching REST Clear promotion', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.installDeferredHydration();
  renderer.context.setRequests([{
    id: 'oversized',
    trafficLifecycleId: 'original-life',
    pinned: true
  }]);
  renderer.context.setSelection('oversized', 'original-life');
  const originalServerGeneration = renderer.context.serverGenerationAt(0);

  renderer.context.applyTrafficCleared('promotion-race', [{
    id: 'oversized',
    trafficGeneration: originalServerGeneration,
    pinned: true,
    _deferredTrafficDetail: true
  }]);
  const hydration = renderer.context.resolveDeferredTrafficRequest(
    renderer.context.requestAt(0)
  );
  assert.equal(renderer.fetchCalls.length, 1);

  renderer.context.applyTrafficCleared('promotion-race', [{
    id: 'oversized',
    trafficLifecycleId: 'remapped-life',
    method: 'GET',
    responseBody: 'complete',
    pinned: true
  }]);
  pending.resolve(rendererResponse({
    id: 'oversized',
    trafficLifecycleId: 'remapped-life',
    method: 'GET',
    responseBody: 'complete',
    pinned: true
  }));

  const resolved = await hydration;
  assert.equal(resolved.trafficLifecycleId, 'remapped-life');
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'oversized',
    trafficLifecycleId: 'remapped-life',
    method: 'GET',
    responseBody: 'complete',
    pinned: true
  }]);
});

test('a REST-first Clear echo removes queued rows and preserves retained action generations', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'BEFORE', pinned: true
  }]);
  renderer.context.setSelection('shared', 'old');
  assert.equal(renderer.context.applyTrafficCleared('rest-first', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REST',
    responseBody: 'complete body', pinned: true
  }], 1, 0, 'rest'), true);

  const generation = renderer.context.captureGenerationAt(0);
  const unpinning = renderer.context.togglePinRequest();
  const retained = renderer.context.requestAt(0);
  renderer.context.setRequests([
    retained,
    {
      id: 'shared', trafficLifecycleId: 'old', method: 'QUEUED-DUPLICATE',
      pinned: true
    },
    { id: 'queued-request', _deferredTrafficDetail: true },
    { id: 'queued-import', method: 'POST' }
  ]);

  assert.equal(renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'rest-first',
    revision: 1,
    p: 0,
    d: 1,
    retainedTraffic: [{ id: 'shared', g: retained.trafficGeneration, l: 'old' }]
  }), true);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REST',
    responseBody: 'complete body', pinned: true
  }]);
  assert.equal(renderer.context.hasGenerationAt(0, generation), true);

  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: false,
    revision: 1
  }));
  await unpinning;
  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange unpinned', type: 'success' }]);
});

test('a REST-first Clear echo restores retained rows replaced by an earlier queued dump', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'BEFORE', pinned: true
  }]);
  assert.equal(renderer.context.applyTrafficCleared('dump-race', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REST', pinned: true
  }], 1, 0, 'rest'), true);
  const generation = renderer.context.captureGenerationAt(0);

  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'QUEUED-DUMP', pinned: true
  }]);
  assert.equal(renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'dump-race',
    revision: 1,
    pinRevision: 0,
    retainedTraffic: [{
      id: 'shared', trafficLifecycleId: 'old', method: 'WS-ECHO', pinned: true
    }]
  }), true);

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REST', pinned: true
  }]);
  assert.equal(renderer.context.hasGenerationAt(0, generation), true);
});

test('a reused generation Pin event cannot override a REST Clear replay barrier', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const retainedGeneration = '00000000-0000-4000-8000-0000000000a1';
  const reusedGeneration = '00000000-0000-4000-8000-0000000000b2';
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'BEFORE', pinned: true,
    trafficGeneration: retainedGeneration
  }]);
  assert.equal(renderer.context.applyTrafficCleared('generation-barrier', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REST', pinned: true,
    trafficGeneration: retainedGeneration
  }], 1, 0, 'rest'), true);

  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'REUSED', pinned: true,
    trafficGeneration: reusedGeneration
  }]);
  assert.equal(renderer.context.applyTrafficPinned(
    'shared', 'old', false, 1, reusedGeneration
  ), true);
  assert.equal(renderer.snapshot().requests[0].pinned, undefined);

  assert.equal(renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'generation-barrier',
    revision: 1,
    pinRevision: 0,
    retainedTraffic: [{
      id: 'shared', trafficLifecycleId: 'old', method: 'WS-ECHO', pinned: true,
      trafficGeneration: retainedGeneration
    }]
  }), true);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REST', pinned: true
  }]);
  assert.equal(renderer.context.serverGenerationAt(0), retainedGeneration);
});

test('a delayed Pin event cannot mutate an exact-identity replacement generation', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const oldGeneration = '00000000-0000-4000-8000-0000000000a1';
  const replacementGeneration = '00000000-0000-4000-8000-0000000000b2';
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT',
    trafficGeneration: replacementGeneration
  }]);

  assert.equal(renderer.context.applyTrafficPinned(
    'shared', 'old', true, 1, oldGeneration
  ), false);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared', trafficLifecycleId: 'old', method: 'REPLACEMENT'
  }]);
  assert.equal(renderer.context.serverGenerationAt(0), replacementGeneration);
});

test('Pin responses defer into a REST Clear barrier across queued dump replacement or removal', async () => {
  for (const scenario of ['started-before-replacement', 'started-before-removal', 'started-after']) {
    const pending = deferred();
    const renderer = createRenderer(() => pending.promise);
    renderer.context.setRequests([{
      id: 'shared', trafficLifecycleId: 'old', method: 'BEFORE', pinned: true
    }]);
    renderer.context.setSelection('shared', 'old');
    assert.equal(renderer.context.applyTrafficCleared('pin-barrier', [{
      id: 'shared', trafficLifecycleId: 'old', method: 'REST', pinned: true
    }], 1, 0, 'rest'), true);
    const restGeneration = renderer.context.captureGenerationAt(0);
    const restServerGeneration = renderer.context.serverGenerationAt(0);

    let unpinning;
    if (scenario.startsWith('started-before')) {
      unpinning = renderer.context.togglePinRequest();
    }
    renderer.context.setRequests(scenario === 'started-before-removal' ? [] : [{
      id: 'shared', trafficLifecycleId: 'old', method: 'QUEUED-DUMP', pinned: true,
      trafficGeneration: restServerGeneration
    }]);
    if (scenario === 'started-after') {
      renderer.context.setSelection('shared', 'old');
      unpinning = renderer.context.togglePinRequest();
    }

    pending.resolve(rendererResponse({
      success: true,
      requestId: 'shared',
      trafficLifecycleId: 'old',
      pinned: false,
      revision: 1
    }));
    await unpinning;
    assert.deepEqual(renderer.toasts, [{ message: 'Exchange unpinned', type: 'success' }]);

    assert.equal(renderer.context.applyTrafficClearedMessage({
      type: 'traffic-cleared',
      clearId: 'pin-barrier',
      revision: 1,
      pinRevision: 0,
      retainedTraffic: [{
        id: 'shared', trafficLifecycleId: 'old', method: 'WS-ECHO', pinned: true
      }]
    }), true);
    assert.equal(renderer.snapshot().requests[0].pinned, undefined);
    assert.equal(renderer.context.hasGenerationAt(0, restGeneration), true);
    assert.equal(renderer.context.applyTrafficPinned('shared', 'old', false, 1), false);
  }
});

test('a Pin response newer than Clear targets only the retained Clear generation', async () => {
  for (const source of ['rest', 'ws']) {
    const pending = deferred();
    const renderer = createRenderer(() => pending.promise);
    renderer.context.setRequests([{
      id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL', pinned: true
    }]);
    renderer.context.setSelection('shared', 'old');
    const unpinning = renderer.context.togglePinRequest();

    assert.equal(renderer.context.applyTrafficCleared(`clear-before-pin-${source}`, [{
      id: 'shared', trafficLifecycleId: 'old', method: 'CLEAR', pinned: true
    }], 1, 0, source), true);
    pending.resolve(rendererResponse({
      success: true,
      requestId: 'shared',
      trafficLifecycleId: 'old',
      pinned: false,
      revision: 1
    }));
    await unpinning;

    assert.equal(renderer.snapshot().requests[0].method, 'CLEAR');
    assert.equal(renderer.snapshot().requests[0].pinned, undefined);
    assert.deepEqual(renderer.toasts, [{ message: 'Exchange unpinned', type: 'success' }]);
  }
});

test('a Clear pin floor confirms an earlier Pin response without a stale-generation error', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'ORIGINAL'
  }]);
  renderer.context.setSelection('shared', 'old');
  const pinning = renderer.context.togglePinRequest();
  renderer.context.applyTrafficCleared('pin-before-clear', [{
    id: 'shared', trafficLifecycleId: 'old', method: 'CLEAR', pinned: true
  }], 1, 1, 'ws');

  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.equal(renderer.snapshot().requests[0].pinned, true);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange pinned', type: 'success' }]);
});

test('Pin rejects a malformed nonpositive response revision without mutating traffic', async () => {
  const renderer = createRenderer(async () => rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 0
  }));

  await renderer.context.togglePinRequest();

  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  assert.equal(renderer.renders, 0);
  assert.equal(renderer.toasts.at(-1).type, 'error');
});

test('a reconnect dump invalidates an older Pin response without consuming its queued event', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  renderer.context.setRequests([{
    id: 'shared', trafficLifecycleId: 'old', method: 'OLD'
  }]);
  renderer.context.setSelection('shared', 'old');
  const pinning = renderer.context.togglePinRequest();

  renderer.context.beginTrafficDumpSync();
  assert.equal(renderer.context.applyTrafficDumpMessage({
    type: 'traffic-dump',
    sessionId: 'session-a',
    requests: [{ id: 'shared', trafficLifecycleId: 'old', method: 'DUMP' }]
  }), true);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.match(renderer.toasts.at(-1).message, /resynchronized/i);
  assert.equal(renderer.context.applyTrafficPinned('shared', 'old', true, 1), true);
  assert.equal(renderer.snapshot().requests[0].method, 'DUMP');
  assert.equal(renderer.snapshot().requests[0].pinned, true);
});

test('Pin is gated between reconnect init and its authoritative dump', async () => {
  const renderer = createRenderer(async () => rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  renderer.context.beginTrafficDumpSync();

  await renderer.context.togglePinRequest();
  assert.equal(renderer.fetchCalls.length, 0);
  assert.match(renderer.toasts.at(-1).message, /still synchronizing/i);

  renderer.context.applyTrafficDumpMessage({
    type: 'traffic-dump',
    sessionId: 'session-a',
    requests: [{ id: 'shared', trafficLifecycleId: 'old' }]
  });
  await renderer.context.togglePinRequest();
  assert.equal(renderer.fetchCalls.length, 1);
  assert.equal(renderer.snapshot().requests[0].pinned, true);
});

test('renderer preserves pin state when the authoritative mutation fails', async () => {
  const renderer = createRenderer(async () => rendererResponse(
    { error: 'pin unavailable' },
    { ok: false, status: 503 }
  ));

  await renderer.context.togglePinRequest();

  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  assert.equal(renderer.renders, 0);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to update pin: pin unavailable',
    type: 'error'
  }]);
  assert.equal(renderer.snapshot().inFlight, 0);
});

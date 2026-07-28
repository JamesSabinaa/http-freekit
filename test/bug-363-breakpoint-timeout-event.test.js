import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function withControlledTimeouts(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];

  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => {
    if (timer) timer.cleared = true;
  };

  try {
    return run(timers);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

function installPending(proxy, requestId, resolutions) {
  const pending = {
    method: 'GET',
    url: 'https://example.test/',
    host: 'example.test',
    timestamp: Date.now(),
    resolve: value => resolutions.push(value)
  };
  proxy.pendingBreakpoints.set(requestId, pending);
  return pending;
}

test('breakpoint timeout emits one ordered resume while other completion paths stay idempotent', () => {
  withControlledTimeouts(timers => {
    const proxy = new ProxyServer(null);
    const events = [];
    const resolutions = [];
    const trafficUpdates = [];
    proxy.onRequest = event => trafficUpdates.push(structuredClone(event));
    proxy.onBreakpoint = event => {
      events.push({
        ...event,
        pendingWhenEmitted: proxy.pendingBreakpoints.has(event.requestId),
        resolutionCountWhenEmitted: resolutions.length
      });
    };

    const abortTarget = new EventEmitter();
    abortTarget.destroyed = false;
    abortTarget.closed = false;
    installPending(proxy, 'timeout', resolutions);
    proxy._setBreakpointTimeout('timeout', abortTarget);

    assert.equal(timers[0].delay, 5 * 60 * 1000);
    timers[0].callback();
    timers[0].callback();

    assert.deepEqual(resolutions, [{}]);
    assert.deepEqual(events, [{
      type: 'breakpoint-resumed',
      requestId: 'timeout',
      reason: 'timeout',
      pendingWhenEmitted: false,
      resolutionCountWhenEmitted: 1
    }]);
    assert.equal(abortTarget.listenerCount('close'), 0);
    assert.equal(proxy.resumeBreakpoint('timeout'), false);

    const replacementResolutions = [];
    const original = installPending(proxy, 'reused-id', resolutions);
    proxy._setBreakpointTimeout('reused-id');
    const staleTimer = timers[1];
    const replacement = {
      ...original,
      resolve: value => replacementResolutions.push(value)
    };
    proxy.pendingBreakpoints.set('reused-id', replacement);
    staleTimer.callback();

    assert.equal(proxy.pendingBreakpoints.get('reused-id'), replacement);
    assert.deepEqual(replacementResolutions, []);
    assert.equal(events.length, 1, 'a stale timeout must not publish a resume');

    proxy.pendingBreakpoints.delete('reused-id');
    installPending(proxy, 'manual', resolutions);
    proxy._setBreakpointTimeout('manual');
    const manualTimer = timers[2];
    assert.equal(proxy.resumeBreakpoint('manual', { method: 'POST' }), true);
    manualTimer.callback();

    assert.deepEqual(events[1], {
      type: 'breakpoint-resumed',
      requestId: 'manual',
      pendingWhenEmitted: false,
      resolutionCountWhenEmitted: 2
    });
    assert.equal(events.length, 2, 'manual resume and its stale timer emit once total');

    const closeTarget = new EventEmitter();
    closeTarget.destroyed = false;
    closeTarget.closed = false;
    installPending(proxy, 'client-close', resolutions);
    proxy._pendingTrafficLogDecisions.set('client-close', true);
    proxy._setBreakpointTimeout('client-close', closeTarget);
    const closeTimer = timers[3];
    closeTarget.emit('close');
    closeTarget.emit('close');
    closeTimer.callback();

    assert.deepEqual(events[2], {
      type: 'breakpoint-resumed',
      requestId: 'client-close',
      reason: 'client-disconnected',
      pendingWhenEmitted: false,
      resolutionCountWhenEmitted: 3
    });
    assert.equal(events.length, 3, 'client close and its stale timer emit once total');
    assert.equal(proxy._pendingTrafficLogDecisions.has('client-close'), false);
    assert.equal(trafficUpdates.length, 1);
    assert.equal(trafficUpdates[0].id, 'client-close');
    assert.equal(trafficUpdates[0].method, 'GET');
    assert.equal(trafficUpdates[0].statusCode, 0);
    assert.equal(trafficUpdates[0].statusMessage, 'Client Disconnected');
    assert.equal(trafficUpdates[0]._mergeUpdate, true);
    assert.equal(trafficUpdates[0]._update, true);
    assert.ok(trafficUpdates[0].duration >= 0);
  });
});

test('manual and timeout resumes immediately clear the active traffic marker', () => {
  withControlledTimeouts(timers => {
    const proxy = new ProxyServer(null);
    const api = new ApiServer(proxy, null, null);
    const resolutions = [];
    proxy.onRequest = event => api.onTrafficEvent(event);

    const seedActiveBreakpoint = (requestId, trafficLifecycleId) => {
      const timestamp = Date.now() - 100;
      proxy._emitPendingRequest({
        id: requestId,
        protocol: 'http',
        method: 'GET',
        url: `http://example.test/${requestId}`,
        host: 'example.test',
        path: `/${requestId}`,
        requestHeaders: {},
        requestBody: '',
        requestBodySize: 0,
        timestamp,
        source: 'breakpoint',
        tls: null,
        remote: null
      }, trafficLifecycleId);
      proxy._storePendingBreakpoint(requestId, {
        method: 'GET',
        url: `http://example.test/${requestId}`,
        host: 'example.test',
        path: `/${requestId}`,
        trafficLifecycleId,
        timestamp,
        resolve: value => resolutions.push({ requestId, value })
      });
      proxy._setBreakpointTimeout(requestId, null, trafficLifecycleId);
      const active = api.trafficLog.find(request =>
        request.id === requestId && request.trafficLifecycleId === trafficLifecycleId
      );
      assert.equal(active?.breakpointActive, true);
    };

    const assertReleased = (requestId, trafficLifecycleId) => {
      const released = api.trafficLog.find(request =>
        request.id === requestId && request.trafficLifecycleId === trafficLifecycleId
      );
      assert.equal(released?.statusCode, null);
      assert.equal(released?.statusMessage, 'Pending');
      assert.equal(released?.breakpointActive, false);
      assert.equal(proxy._selectPendingBreakpoint(requestId, trafficLifecycleId), null);
      assert.ok(proxy._selectPendingTrafficLogDecision(
        { id: requestId }, trafficLifecycleId
      )?.decision, 'the eventual completion must retain its lifecycle decision');
    };

    seedActiveBreakpoint('manual', 'manual-life');
    assert.equal(proxy.resumeBreakpoint('manual', {}, 'manual-life'), true);
    assertReleased('manual', 'manual-life');

    seedActiveBreakpoint('timeout', 'timeout-life');
    timers[1].callback();
    assertReleased('timeout', 'timeout-life');

    assert.deepEqual(resolutions, [
      { requestId: 'manual', value: {} },
      { requestId: 'timeout', value: {} }
    ]);
  });
});

test('renderer refreshes the breakpoint banner for timeout resume events', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function handleWsMessage(');
  const end = source.indexOf('// ============ TRAFFIC ============', start);
  assert.ok(start >= 0 && end > start, 'WebSocket message handler must be present');

  let bannerRefreshes = 0;
  const clearedDrafts = [];
  const context = {
    clearBreakpointEditDraft: (...args) => clearedDrafts.push(args),
    updateBreakpointBanner: () => { bannerRefreshes++; }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.handle = handleWsMessage;
  `, context);

  context.handle({
    type: 'breakpoint-resumed',
    requestId: 'timed-out-request',
    trafficLifecycleId: 'timed-out-life',
    reason: 'timeout'
  });

  assert.equal(bannerRefreshes, 1);
  assert.deepEqual(clearedDrafts, [['timed-out-request', 'timed-out-life']]);
});

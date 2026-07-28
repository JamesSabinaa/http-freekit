import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

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
  });
});

test('renderer refreshes the breakpoint banner for timeout resume events', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function handleWsMessage(');
  const end = source.indexOf('// ============ TRAFFIC ============', start);
  assert.ok(start >= 0 && end > start, 'WebSocket message handler must be present');

  let bannerRefreshes = 0;
  const context = {
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
    reason: 'timeout'
  });

  assert.equal(bannerRefreshes, 1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const loadSource = extract('let interceptorStateGeneration = 0;', 'const NODE_ENV_PROXY_SUPPORT_NOTE');
const statusSource = extract('function handleInterceptorStatusEvent(', 'function filterInterceptors(');

function createHarness(initialInterceptors = []) {
  const calls = [];
  const renders = [];
  const context = {
    API_BASE: '',
    AbortController,
    console,
    fetch(url, options = {}) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      calls.push({ url, options, resolve });
      return promise;
    },
    renderInterceptors(interceptors) {
      renders.push(interceptors.map(item => ({ ...item })));
      context.interceptorApi.set(interceptors);
    },
    renderConnectedSources() {},
    filterInterceptors() {},
    collapseInterceptorCard() {},
    getAndroidSummaryFields: () => ({})
  };
  vm.createContext(context);
  vm.runInContext(`
    let allInterceptors = ${JSON.stringify(initialInterceptors)};
    let expandedInterceptorId = null;
    ${loadSource}
    ${statusSource}
    globalThis.interceptorApi = {
      load: loadInterceptors,
      status: handleInterceptorStatusEvent,
      get: () => allInterceptors,
      set: value => { allInterceptors = value; }
    };
  `, context);
  return {
    api: context.interceptorApi,
    calls,
    renders,
    respond(index, interceptors) {
      calls[index].resolve({ json: async () => ({ interceptors }) });
    }
  };
}

test('only the newest aggregate interceptor load may replace renderer state', async () => {
  const harness = createHarness();
  const older = harness.api.load();
  const newer = harness.api.load();
  assert.equal(harness.calls[0].options.signal.aborted, true);

  harness.respond(1, [{ id: 'chrome', active: true }]);
  await newer;
  harness.respond(0, [{ id: 'chrome', active: false }]);
  await older;

  assert.equal(harness.api.get()[0].active, true);
  assert.equal(harness.renders.length, 1);
});

test('a live status event invalidates an older aggregate response', async () => {
  const harness = createHarness([{ id: 'chrome', active: false }]);
  const staleLoad = harness.api.load();

  harness.api.status({ id: 'chrome', active: true, pid: 42 });
  assert.equal(harness.calls[0].options.signal.aborted, true);
  assert.equal(harness.api.get()[0].active, true);

  harness.respond(0, [{ id: 'chrome', active: false, pid: null }]);
  await staleLoad;

  assert.equal(harness.api.get()[0].active, true);
  assert.equal(harness.api.get()[0].pid, 42);
  assert.equal(harness.renders.length, 0);
});

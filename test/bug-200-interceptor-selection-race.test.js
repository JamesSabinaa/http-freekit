import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const stateStart = source.indexOf('let allInterceptors = [];');
const stateEnd = source.indexOf('// Interceptors that have expandable config components', stateStart);
const selectionStart = source.indexOf('async function handleExpandableCardClick(');
const selectionEnd = source.indexOf('function renderInterceptorConfig(', selectionStart);
const refreshStart = source.indexOf('async function refreshJvmProcesses(');
const refreshEnd = source.indexOf('async function focusInterceptor(', refreshStart);
for (const offset of [stateStart, stateEnd, selectionStart, selectionEnd, refreshStart, refreshEnd]) {
  assert.notEqual(offset, -1);
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

function createHarness(fetch) {
  const toasts = [];
  let filterCalls = 0;
  const context = {
    API_BASE: '',
    console,
    fetch,
    document: { getElementById: () => null },
    filterInterceptors: () => { filterCalls++; },
    renderConnectedSources: () => {},
    renderJvmConfig: () => {},
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(stateStart, stateEnd)}
    ${source.slice(selectionStart, selectionEnd)}
    ${source.slice(refreshStart, refreshEnd)}
  `, context);
  return {
    context,
    toasts,
    get filterCalls() { return filterCalls; },
    state() {
      return JSON.parse(vm.runInContext(`JSON.stringify({
        expandedInterceptorId,
        expandedInterceptorMetadata,
        progress: [...interceptorsInProgress].sort()
      })`, context));
    }
  };
}

test('older card success and failure responses cannot replace a newer selection', async () => {
  for (const olderResult of ['success', 'failure']) {
    const android = deferred();
    const jvm = deferred();
    let listRequests = 0;
    const harness = createHarness(async url => {
      if (url === '/api/interceptors') {
        listRequests++;
        return response({ interceptors: [] });
      }
      if (url.endsWith('/android-adb/activate')) return android.promise;
      if (url.endsWith('/jvm/activate')) return jvm.promise;
      throw new Error(`Unexpected URL: ${url}`);
    });

    const olderSelection = harness.context.handleExpandableCardClick('android-adb', false);
    const newerSelection = harness.context.handleExpandableCardClick('jvm', false);
    assert.deepEqual(harness.state().progress, ['android-adb', 'jvm']);

    jvm.resolve(response({ metadata: { card: 'jvm', processes: ['current'] } }));
    await newerSelection;
    assert.deepEqual(harness.state(), {
      expandedInterceptorId: 'jvm',
      expandedInterceptorMetadata: { card: 'jvm', processes: ['current'] },
      progress: ['android-adb']
    });

    android.resolve(response(olderResult === 'success'
      ? { metadata: { card: 'android-adb', devices: ['stale'] } }
      : { error: 'stale Android failure' }));
    await olderSelection;

    assert.deepEqual(harness.state(), {
      expandedInterceptorId: 'jvm',
      expandedInterceptorMetadata: { card: 'jvm', processes: ['current'] },
      progress: []
    });
    assert.equal(listRequests, 1);
    assert.deepEqual(harness.toasts, []);
  }
});

test('metadata refresh completion cannot overwrite a newly selected card', async () => {
  const staleJvmRefresh = deferred();
  let jvmActivations = 0;
  const harness = createHarness(async url => {
    if (url === '/api/interceptors') return response({ interceptors: [] });
    if (url.endsWith('/jvm/activate')) {
      jvmActivations++;
      if (jvmActivations === 1) {
        return response({ metadata: { card: 'jvm', processes: ['initial'] } });
      }
      return staleJvmRefresh.promise;
    }
    if (url.endsWith('/android-adb/activate')) {
      return response({ metadata: { card: 'android-adb', devices: ['current'] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  await harness.context.handleExpandableCardClick('jvm', false);
  const refresh = harness.context.refreshJvmProcesses();
  await harness.context.handleExpandableCardClick('android-adb', false);
  assert.equal(harness.state().expandedInterceptorId, 'android-adb');

  staleJvmRefresh.resolve(response({ metadata: { card: 'jvm', processes: ['stale'] } }));
  await refresh;

  assert.deepEqual(harness.state(), {
    expandedInterceptorId: 'android-adb',
    expandedInterceptorMetadata: { card: 'android-adb', devices: ['current'] },
    progress: []
  });
  assert.deepEqual(harness.toasts, []);
});

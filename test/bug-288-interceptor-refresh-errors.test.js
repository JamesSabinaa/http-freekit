import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const stateStart = source.indexOf('let allInterceptors = [];');
const stateEnd = source.indexOf('// Interceptors that have expandable config components', stateStart);
const androidStart = source.indexOf('async function readInterceptorRefreshMetadata(');
const androidEnd = source.indexOf('function renderJvmConfig(', androidStart);
const jvmStart = source.indexOf('async function refreshJvmProcesses(');
const jvmEnd = source.indexOf('async function focusInterceptor(', jvmStart);
for (const offset of [stateStart, stateEnd, androidStart, androidEnd, jvmStart, jvmEnd]) {
  assert.notEqual(offset, -1);
}

const targets = [
  {
    id: 'android-adb',
    functionName: 'refreshAndroidDevices',
    listKey: 'devices',
    activatedListKey: 'activatedDevices',
    successMessage: 'Device list refreshed',
    errorPrefix: 'Error refreshing devices'
  },
  {
    id: 'jvm',
    functionName: 'refreshJvmProcesses',
    listKey: 'processes',
    activatedListKey: 'activatedProcesses',
    successMessage: 'Process list refreshed',
    errorPrefix: 'Error refreshing processes'
  }
];

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function createHarness(target, fetch) {
  const toasts = [];
  let renders = 0;
  const context = {
    API_BASE: '',
    console,
    fetch,
    document: {
      getElementById: id => id === `interceptConfig-${target.id}` ? {} : null
    },
    renderAndroidConfig: () => { renders++; },
    renderJvmConfig: () => { renders++; },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(stateStart, stateEnd)}
    ${source.slice(androidStart, androidEnd)}
    ${source.slice(jvmStart, jvmEnd)}
    expandedInterceptorId = ${JSON.stringify(target.id)};
    expandedInterceptorMetadata = {
      marker: 'preserved',
      ${target.listKey}: [{ id: 'stale' }],
      ${target.activatedListKey}: [{ id: 'stale-active' }]
    };
  `, context);
  return {
    context,
    toasts,
    get renders() { return renders; },
    metadata() {
      return JSON.parse(vm.runInContext('JSON.stringify(expandedInterceptorMetadata)', context));
    }
  };
}

for (const target of targets) {
  test(`${target.id} refresh replaces lists only after a confirmed success`, async () => {
    const metadata = {
      [target.listKey]: [{ id: 'fresh' }],
      [target.activatedListKey]: [{ id: 'fresh-active' }]
    };
    const harness = createHarness(target, async () => jsonResponse({ success: true, metadata }));

    await harness.context[target.functionName]();

    assert.deepEqual(harness.metadata(), { marker: 'preserved', ...metadata });
    assert.equal(harness.renders, 1);
    assert.deepEqual(harness.toasts, [{ message: target.successMessage, type: 'success' }]);
  });

  test(`${target.id} refresh accepts valid empty lists`, async () => {
    const metadata = {
      [target.listKey]: [],
      [target.activatedListKey]: []
    };
    const harness = createHarness(target, async () => jsonResponse({ success: true, metadata }));

    await harness.context[target.functionName]();

    assert.deepEqual(harness.metadata(), { marker: 'preserved', ...metadata });
    assert.equal(harness.renders, 1);
    assert.deepEqual(harness.toasts, [{ message: target.successMessage, type: 'success' }]);
  });

  const failures = [
    {
      name: 'HTTP failure',
      fetch: async () => jsonResponse(
        { error: 'server discovery failed' },
        { ok: false, status: 500 }
      ),
      message: 'server discovery failed'
    },
    {
      name: 'logical failure',
      fetch: async () => jsonResponse({ success: false, error: 'discovery unavailable' }),
      message: 'discovery unavailable'
    },
    {
      name: 'incomplete response',
      fetch: async () => jsonResponse({ success: true, metadata: {} }),
      message: 'Refresh response was incomplete'
    },
    {
      name: 'malformed response',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('bad JSON'); }
      }),
      message: 'Refresh response was not valid JSON'
    },
    {
      name: 'network rejection',
      fetch: async () => { throw new Error('network offline'); },
      message: 'network offline'
    }
  ];

  for (const failure of failures) {
    test(`${target.id} refresh rejects ${failure.name} without replacing stale lists`, async () => {
      const harness = createHarness(target, failure.fetch);
      const before = harness.metadata();

      await harness.context[target.functionName]();

      assert.deepEqual(harness.metadata(), before);
      assert.equal(harness.renders, 0);
      assert.deepEqual(harness.toasts, [{
        message: `${target.errorPrefix}: ${failure.message}`,
        type: 'error'
      }]);
    });
  }
}

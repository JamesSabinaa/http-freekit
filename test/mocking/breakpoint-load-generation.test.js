import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const loadSource = section('async function loadBreakpointRules()', '// Helper: find a mock rule');
const deleteSource = section('async function deleteBreakpointRule(', 'function renderMockRuleDetail(');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createHarness() {
  const gets = [];
  const deletion = deferred();
  const toasts = [];
  let renders = 0;
  const context = {
    API_BASE: 'http://127.0.0.1:8080',
    fetch(_url, options = {}) {
      if (options.method === 'DELETE') return deletion.promise;
      const request = deferred();
      gets.push(request);
      return request.promise;
    },
    renderMockRules: () => { renders++; },
    toast: (...args) => toasts.push(args),
    encodeURIComponent,
    console
  };
  vm.createContext(context);
  vm.runInContext(`
    let breakpointRules = [];
    let breakpointRulesLoadGeneration = 0;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    const _queueMockCollectionMutation = operation => operation();
    ${loadSource}
    ${deleteSource}
    globalThis.breakpointApi = {
      load: loadBreakpointRules,
      remove: deleteBreakpointRule,
      rules: () => breakpointRules
    };
  `, context);
  return { api: context.breakpointApi, deletion, gets, renders: () => renders, toasts };
}

test('a later breakpoint load wins when GET responses complete out of order', async () => {
  const harness = createHarness();
  const first = harness.api.load();
  const second = harness.api.load();
  assert.equal(harness.gets.length, 2);

  harness.gets[1].resolve({ json: async () => ({ rules: [{ id: 'new' }] }) });
  assert.equal(await second, true);
  harness.gets[0].resolve({ json: async () => ({ rules: [{ id: 'old' }] }) });
  assert.equal(await first, false);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.api.rules())), [{ id: 'new' }]);
  assert.equal(harness.renders(), 1);
});

test('starting a breakpoint delete invalidates an earlier pending read', async () => {
  const harness = createHarness();
  const stale = harness.api.load();
  const removal = harness.api.remove('removed');

  harness.gets[0].resolve({ json: async () => ({ rules: [{ id: 'removed' }] }) });
  assert.equal(await stale, false);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.api.rules())), []);

  harness.deletion.resolve({ ok: true, json: async () => ({ success: true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.gets.length, 2);
  harness.gets[1].resolve({ json: async () => ({ rules: [] }) });
  await removal;
  assert.deepEqual(JSON.parse(JSON.stringify(harness.api.rules())), []);
  assert.equal(harness.renders(), 1);
  assert.deepEqual(harness.toasts, [['Breakpoint deleted', 'success']]);
});

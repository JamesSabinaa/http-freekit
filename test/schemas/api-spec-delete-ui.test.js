import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const removeStart = rendererSource.indexOf('async function removeApiSpec(');
const removeEnd = rendererSource.indexOf('function togglePause(', removeStart);
assert.ok(removeStart >= 0 && removeEnd > removeStart);
const renderStart = rendererSource.indexOf('function renderApiSpecs(');
const renderEnd = rendererSource.indexOf('async function readApiSpecUploadResponse(', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);

function harness(fetchImplementation, initialSpecs = [{ id: 'spec-id', title: 'Spec' }]) {
  const fetchCalls = [];
  const toasts = [];
  const renders = [];
  let reloads = 0;
  const context = {
    API_BASE: 'http://127.0.0.1:8001',
    renderedApiSpecs: initialSpecs.map(spec => ({ ...spec })),
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetchImplementation(...args);
    },
    beginSettingsMutation: key => ({ key }),
    isCurrentSettingsOperation: () => true,
    finishSettingsMutation() {},
    renderApiSpecs: specs => {
      context.renderedApiSpecs = specs.map(spec => ({ ...spec }));
      renders.push(context.renderedApiSpecs);
    },
    loadApiSpecs: async () => { reloads += 1; },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(
    `${rendererSource.slice(removeStart, removeEnd)}; globalThis.removeApiSpec = removeApiSpec;`,
    context
  );
  return {
    remove: id => context.removeApiSpec(id),
    fetchCalls,
    renders,
    specs: () => context.renderedApiSpecs,
    toasts,
    reloads: () => reloads
  };
}

function response({ ok, status, body, jsonError }) {
  return {
    ok,
    status,
    json: async () => {
      if (jsonError) throw jsonError;
      return body;
    }
  };
}

test('confirmed API-spec deletion safely targets the ID, updates the list, and reports success', async () => {
  const ui = harness(async () => response({
    ok: true,
    status: 200,
    body: { success: true }
  }), [
    { id: 'spec/with ? delimiters', title: 'Remove me' },
    { id: 'keep', title: 'Keep me' }
  ]);

  await ui.remove('spec/with ? delimiters');

  assert.equal(ui.fetchCalls.length, 1);
  assert.equal(
    ui.fetchCalls[0][0],
    'http://127.0.0.1:8001/api/specs/spec%2Fwith%20%3F%20delimiters'
  );
  assert.equal(ui.fetchCalls[0][1].method, 'DELETE');
  assert.equal(ui.reloads(), 0);
  assert.deepEqual(ui.specs(), [{ id: 'keep', title: 'Keep me' }]);
  assert.equal(ui.renders.length, 1);
  assert.deepEqual(ui.toasts, [{ message: 'Spec removed', type: 'success' }]);
});

test('HTTP deletion failure shows the server message and leaves the list intact', async () => {
  const ui = harness(async () => response({
    ok: false,
    status: 500,
    body: { error: 'Spec storage is read-only' }
  }));

  await ui.remove('spec-id');

  assert.equal(ui.reloads(), 0);
  assert.deepEqual(ui.specs(), [{ id: 'spec-id', title: 'Spec' }]);
  assert.deepEqual(ui.toasts, [{
    message: 'Failed to remove spec: Spec storage is read-only',
    type: 'error'
  }]);
  assert.equal(ui.toasts.some(toast => toast.type === 'success'), false);
});

test('network deletion failure is visible without reload or success', async () => {
  const ui = harness(async () => {
    throw new Error('connection refused');
  });

  await ui.remove('spec-id');

  assert.equal(ui.reloads(), 0);
  assert.deepEqual(ui.specs(), [{ id: 'spec-id', title: 'Spec' }]);
  assert.deepEqual(ui.toasts, [{
    message: 'Failed to remove spec: connection refused',
    type: 'error'
  }]);
  assert.equal(ui.toasts.some(toast => toast.type === 'success'), false);
});

test('malformed and explicit logical failures cannot report deletion success', async () => {
  const scenarios = [
    {
      fetch: async () => response({
        ok: true,
        status: 200,
        jsonError: new SyntaxError('invalid JSON')
      }),
      message: 'Failed to remove spec: Server returned an invalid deletion response'
    },
    {
      fetch: async () => response({
        ok: true,
        status: 200,
        body: { success: false, error: 'Spec is locked' }
      }),
      message: 'Failed to remove spec: Spec is locked'
    }
  ];

  for (const scenario of scenarios) {
    const ui = harness(scenario.fetch);
    await ui.remove('spec-id');
    assert.equal(ui.reloads(), 0);
    assert.deepEqual(ui.specs(), [{ id: 'spec-id', title: 'Spec' }]);
    assert.deepEqual(ui.toasts, [{ message: scenario.message, type: 'error' }]);
    assert.equal(ui.toasts.some(toast => toast.type === 'success'), false);
  }
});

test('API spec IDs stay inert in data attributes instead of becoming onclick source', () => {
  const list = { innerHTML: '' };
  const context = {
    document: { getElementById: () => list },
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    escapeHtmlAttribute: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  };
  vm.createContext(context);
  vm.runInContext(`${rendererSource.slice(renderStart, renderEnd)}; globalThis.render = renderApiSpecs;`, context);
  context.render([{
    id: `" onclick="document.body.dataset.pwned='1'`,
    title: 'Hostile spec',
    baseUrl: 'https://example.test'
  }]);

  assert.match(list.innerHTML, /onclick="removeApiSpec\(this\.dataset\.specId\)"/);
  assert.doesNotMatch(list.innerHTML, /onclick="document\.body/);
  assert.match(list.innerHTML, /data-spec-id="&quot; onclick=&quot;document\.body/);
});

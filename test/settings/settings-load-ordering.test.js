import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const listAndScalarSource = slice(
  'const settingsOperationStates = new Map();',
  '// ============ MCP SERVER'
);
const apiSpecSource = slice('// ============ API SPECS', 'function togglePause()');

function createHarness() {
  const calls = [];
  const toasts = [];
  let createdFileInput = null;
  const elements = Object.fromEntries([
    'tlsPassthroughList', 'clientCertList', 'trustedCAList', 'httpsWhitelistList',
    'apiSpecsList'
  ].map(id => [id, { innerHTML: '' }]));
  Object.assign(elements, {
    tlsPassthroughInput: { value: 'new-tls.example' },
    http2Mode: { value: 'disabled' },
    tlsFingerprint: { value: 'chrome' },
    clientCertHost: { value: 'client.example' },
    clientCertPath: { value: 'client.p12' },
    clientCertPassphrase: { value: '' },
    trustedCAPath: { value: 'trusted.pem' },
    httpsWhitelistHost: { value: 'allowed.example' }
  });

  const context = {
    API_BASE: '',
    AbortController,
    console,
    document: {
      getElementById: id => elements[id] || null,
      createElement() {
        createdFileInput = { click() {} };
        return createdFileInput;
      }
    },
    prompt: () => 'https://api.example.test',
    esc: value => String(value),
    escapeHtmlAttribute: value => String(value),
    toast: (message, type) => toasts.push({ message, type }),
    fetch(url, options = {}) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      calls.push({ url, options, resolve });
      return promise;
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${listAndScalarSource}
    ${apiSpecSource}
    globalThis.settingsApi = {
      loadTlsPassthrough, addTlsPassthrough,
      loadClientCerts, addClientCert,
      loadTrustedCAs, addTrustedCA,
      loadHttpsWhitelist, addHttpsWhitelist,
      loadHttp2Config, saveHttp2Config,
      loadTlsFingerprint, saveTlsFingerprint,
      loadApiSpecs, uploadApiSpec, removeApiSpec, renderApiSpecs,
      getTls: () => renderedTlsPassthroughHosts,
      getClient: () => renderedClientCertificates,
      getTrusted: () => renderedTrustedCAs,
      getWhitelist: () => renderedHttpsWhitelistHosts,
      getSpecs: () => renderedApiSpecs
    };
  `, context);

  return {
    api: context.settingsApi,
    calls,
    elements,
    toasts,
    get createdFileInput() { return createdFileInput; },
    respond(index, data, { ok = true, status = ok ? 200 : 400 } = {}) {
      calls[index].resolve({ ok, status, json: async () => data });
    }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('timed out waiting for asynchronous renderer work');
}

test('every affected settings loader ignores an older completion after a newer load', async () => {
  const cases = [
    { load: 'loadTlsPassthrough', field: 'hosts', old: ['old'], fresh: ['fresh'], read: h => plain(h.api.getTls()) },
    { load: 'loadClientCerts', field: 'certificates', old: [{ host: 'old' }], fresh: [{ host: 'fresh' }], read: h => plain(h.api.getClient()) },
    { load: 'loadTrustedCAs', field: 'cas', old: ['old.pem'], fresh: ['fresh.pem'], read: h => plain(h.api.getTrusted()) },
    { load: 'loadHttpsWhitelist', field: 'hosts', old: ['old'], fresh: ['fresh'], read: h => plain(h.api.getWhitelist()) },
    { load: 'loadHttp2Config', field: 'mode', old: 'all', fresh: 'h2-only', read: h => h.elements.http2Mode.value },
    { load: 'loadTlsFingerprint', field: 'fingerprint', old: 'passthrough', fresh: 'chrome', read: h => h.elements.tlsFingerprint.value },
    { load: 'loadApiSpecs', field: 'specs', old: [{ id: 'old' }], fresh: [{ id: 'fresh' }], read: h => plain(h.api.getSpecs()) }
  ];

  for (const item of cases) {
    const harness = createHarness();
    const older = harness.api[item.load]();
    const newer = harness.api[item.load]();
    assert.equal(harness.calls[0].options.signal.aborted, true, item.load);

    harness.respond(1, { [item.field]: item.fresh });
    await newer;
    harness.respond(0, { [item.field]: item.old });
    await older;

    assert.deepEqual(item.read(harness), item.fresh, item.load);
  }
});

test('list mutations invalidate old reads and render their authoritative response collections', async () => {
  const cases = [
    { load: 'loadTlsPassthrough', mutate: 'addTlsPassthrough', field: 'hosts', fresh: ['new-tls.example'], old: ['old'], read: h => plain(h.api.getTls()) },
    { load: 'loadClientCerts', mutate: 'addClientCert', field: 'certificates', fresh: [{ host: 'client.example', pfxPath: 'client.p12' }], old: [{ host: 'old' }], read: h => plain(h.api.getClient()) },
    { load: 'loadTrustedCAs', mutate: 'addTrustedCA', field: 'cas', fresh: ['trusted.pem'], old: ['old.pem'], read: h => plain(h.api.getTrusted()) },
    { load: 'loadHttpsWhitelist', mutate: 'addHttpsWhitelist', field: 'hosts', fresh: ['allowed.example'], old: ['old'], read: h => plain(h.api.getWhitelist()) }
  ];

  for (const item of cases) {
    const harness = createHarness();
    const staleLoad = harness.api[item.load]();
    const mutation = harness.api[item.mutate]();
    assert.equal(harness.calls[0].options.signal.aborted, true, item.mutate);

    harness.respond(1, { success: true, [item.field]: item.fresh });
    await mutation;
    harness.respond(0, { [item.field]: item.old });
    await staleLoad;

    assert.deepEqual(item.read(harness), item.fresh, item.mutate);
    assert.equal(harness.toasts.some(toast => toast.type === 'error'), false, item.mutate);
  }
});

test('scalar saves and API-spec deletion remain newer than pending startup reads', async () => {
  {
    const harness = createHarness();
    const staleLoad = harness.api.loadHttp2Config();
    const save = harness.api.saveHttp2Config();
    harness.respond(1, { success: true, mode: 'disabled' });
    await save;
    harness.respond(0, { mode: 'all' });
    await staleLoad;
    assert.equal(harness.elements.http2Mode.value, 'disabled');
  }

  {
    const harness = createHarness();
    const staleLoad = harness.api.loadTlsFingerprint();
    const save = harness.api.saveTlsFingerprint();
    harness.respond(1, { success: true, fingerprint: 'chrome' });
    await save;
    harness.respond(0, { fingerprint: 'passthrough' });
    await staleLoad;
    assert.equal(harness.elements.tlsFingerprint.value, 'chrome');
  }

  {
    const harness = createHarness();
    harness.api.renderApiSpecs([{ id: 'remove-me', title: 'Old spec' }]);
    const staleLoad = harness.api.loadApiSpecs();
    const remove = harness.api.removeApiSpec('remove-me');
    harness.respond(1, { success: true });
    await remove;
    harness.respond(0, { specs: [{ id: 'remove-me', title: 'Old spec' }] });
    await staleLoad;
    assert.deepEqual(plain(harness.api.getSpecs()), []);
  }
});

test('API-spec upload invalidates an older list read and applies returned spec metadata', async () => {
  const harness = createHarness();
  const staleLoad = harness.api.loadApiSpecs();
  harness.api.uploadApiSpec();
  const upload = harness.createdFileInput.onchange({
    target: {
      files: [{
        name: 'petstore.json',
        size: 128,
        text: async () => JSON.stringify({ info: { title: 'Petstore' } })
      }]
    }
  });
  await waitFor(() => harness.calls.length === 2);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].options.signal.aborted, true);

  harness.respond(1, {
    success: true,
    spec: { id: 'petstore', title: 'Petstore', baseUrl: 'https://api.example.test' }
  });
  await upload;
  harness.respond(0, { specs: [{ id: 'stale', title: 'Stale' }] });
  await staleLoad;

  assert.deepEqual(plain(harness.api.getSpecs()), [{
    id: 'petstore',
    title: 'Petstore',
    baseUrl: 'https://api.example.test'
  }]);
});

test('loads are suppressed while the corresponding mutation is still in flight', async () => {
  const harness = createHarness();
  const mutation = harness.api.addTlsPassthrough();
  assert.equal(await harness.api.loadTlsPassthrough(), false);
  assert.equal(harness.calls.length, 1);
  harness.respond(0, { success: true, hosts: ['new-tls.example'] });
  await mutation;
});

test('overlapping same-key mutations reload after both settle to reflect server completion order', async () => {
  const harness = createHarness();
  harness.elements.http2Mode.value = 'h2-only';
  const older = harness.api.saveHttp2Config();
  harness.elements.http2Mode.value = 'disabled';
  const newer = harness.api.saveHttp2Config();

  harness.respond(1, { success: true, mode: 'disabled' });
  await newer;
  assert.equal(harness.elements.http2Mode.value, 'disabled');

  harness.respond(0, { success: true, mode: 'h2-only' });
  await older;
  assert.equal(harness.calls.length, 3, 'last overlapping completion must trigger a guarded reload');
  harness.respond(2, { mode: 'h2-only' });
  await waitFor(() => harness.elements.http2Mode.value === 'h2-only');

  assert.equal(harness.elements.http2Mode.value, 'h2-only');
});

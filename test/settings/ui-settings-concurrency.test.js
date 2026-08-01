import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/ui-settings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
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

async function createApi(t) {
  const values = { hideTunnelRequests: true, filterSafeFonts: false };
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = {
    get(key, fallback) {
      return Object.hasOwn(values, key) ? values[key] : fallback;
    },
    set(key, value) {
      values[key] = value;
    }
  };
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, values };
}

test('API one-field UI setting updates preserve the other field in both directions', async t => {
  const { port, values } = await createApi(t);

  const fontsChanged = await postJson(port, { filterSafeFonts: true });
  assert.equal(fontsChanged.statusCode, 200);
  assert.deepEqual(fontsChanged.body, {
    success: true,
    hideTunnelRequests: true,
    filterSafeFonts: true
  });

  const hideChangedFromStaleTab = await postJson(port, { hideTunnelRequests: false });
  assert.equal(hideChangedFromStaleTab.statusCode, 200);
  assert.deepEqual(hideChangedFromStaleTab.body, {
    success: true,
    hideTunnelRequests: false,
    filterSafeFonts: true
  });
  assert.deepEqual(values, { hideTunnelRequests: false, filterSafeFonts: true });

  values.hideTunnelRequests = true;
  values.filterSafeFonts = false;
  await postJson(port, { hideTunnelRequests: false });
  const fontsChangedFromStaleTab = await postJson(port, { filterSafeFonts: true });
  assert.deepEqual(fontsChangedFromStaleTab.body, {
    success: true,
    hideTunnelRequests: false,
    filterSafeFonts: true
  });
  assert.deepEqual(values, { hideTunnelRequests: false, filterSafeFonts: true });
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const settingsStart = rendererSource.indexOf('let uiSettingsSaveGeneration = 0;');
const settingsEnd = rendererSource.indexOf('// ============ ROW NAVIGATION', settingsStart);
assert.notEqual(settingsStart, -1);
assert.notEqual(settingsEnd, -1);

function createTab(serverState, initialSettings = { hideTunnelRequests: true, filterSafeFonts: false }) {
  const requestBodies = [];
  const toasts = [];
  const toggles = {
    hideTunnelRequestsToggle: { checked: initialSettings.hideTunnelRequests },
    filterSafeFontsToggle: { checked: initialSettings.filterSafeFonts }
  };
  let filterCalls = 0;
  const context = {
    API_BASE: '',
    console,
    document: { getElementById: id => toggles[id] || null },
    applyFilter: () => { filterCalls++; },
    toast: (message, type) => toasts.push({ message, type }),
    fetch: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      Object.assign(serverState, body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, ...serverState })
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let hideTunnelRequests = ${JSON.stringify(initialSettings.hideTunnelRequests)};
    let filterSafeFonts = ${JSON.stringify(initialSettings.filterSafeFonts)};
    ${rendererSource.slice(settingsStart, settingsEnd)}
  `, context);
  return {
    context,
    requestBodies,
    toasts,
    toggles,
    get filterCalls() { return filterCalls; },
    settings() {
      return JSON.parse(JSON.stringify(
        vm.runInContext('({ hideTunnelRequests, filterSafeFonts })', context)
      ));
    }
  };
}

test('stale renderer tabs send one-key updates and learn the canonical other setting', async () => {
  const firstServer = { hideTunnelRequests: true, filterSafeFonts: false };
  const firstTab = createTab(firstServer);
  const staleHideTab = createTab(firstServer);
  await firstTab.context.saveFilterSafeFonts(true);
  await staleHideTab.context.saveHideTunnelRequests(false);

  assert.deepEqual(firstTab.requestBodies, [{ filterSafeFonts: true }]);
  assert.deepEqual(staleHideTab.requestBodies, [{ hideTunnelRequests: false }]);
  assert.deepEqual(staleHideTab.settings(), { hideTunnelRequests: false, filterSafeFonts: true });
  assert.equal(staleHideTab.toggles.filterSafeFontsToggle.checked, true);

  const secondServer = { hideTunnelRequests: true, filterSafeFonts: false };
  const secondTab = createTab(secondServer);
  const staleFontsTab = createTab(secondServer);
  await secondTab.context.saveHideTunnelRequests(false);
  await staleFontsTab.context.saveFilterSafeFonts(true);

  assert.deepEqual(secondTab.requestBodies, [{ hideTunnelRequests: false }]);
  assert.deepEqual(staleFontsTab.requestBodies, [{ filterSafeFonts: true }]);
  assert.deepEqual(staleFontsTab.settings(), { hideTunnelRequests: false, filterSafeFonts: true });
  assert.equal(staleFontsTab.toggles.hideTunnelRequestsToggle.checked, false);
});

test('failed renderer saves restore optimistic state and never show success', async () => {
  const serverState = { hideTunnelRequests: true, filterSafeFonts: false };
  const tab = createTab(serverState);
  tab.context.fetch = async (_url, options) => {
    tab.requestBodies.push(JSON.parse(options.body));
    return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) };
  };

  await tab.context.saveHideTunnelRequests(false);

  assert.deepEqual(tab.requestBodies, [{ hideTunnelRequests: false }]);
  assert.deepEqual(tab.settings(), { hideTunnelRequests: true, filterSafeFonts: false });
  assert.equal(tab.toggles.hideTunnelRequestsToggle.checked, true);
  assert.equal(tab.filterCalls, 2);
  assert.deepEqual(tab.toasts, [{ message: 'Error: disk full', type: 'error' }]);
});

test('incomplete successful responses are rejected instead of corrupting cached settings', async () => {
  const tab = createTab({ hideTunnelRequests: true, filterSafeFonts: false });
  tab.context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, hideTunnelRequests: false })
  });

  await tab.context.saveHideTunnelRequests(false);

  assert.deepEqual(tab.settings(), { hideTunnelRequests: true, filterSafeFonts: false });
  assert.equal(tab.toggles.hideTunnelRequestsToggle.checked, true);
  assert.deepEqual(tab.toasts, [
    { message: 'Error: UI settings response was incomplete', type: 'error' }
  ]);
});

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function settingsResponse(settings, { ok = true, error } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => ok ? { success: true, ...settings } : { error }
  };
}

test('late older save responses cannot overwrite or roll back newer same-tab state', async () => {
  for (const olderResult of ['success', 'failure']) {
    const tab = createTab({ hideTunnelRequests: true, filterSafeFonts: false });
    const older = deferred();
    const newer = deferred();
    let requestCount = 0;
    tab.context.fetch = async (_url, options) => {
      tab.requestBodies.push(JSON.parse(options.body));
      return (++requestCount === 1 ? older : newer).promise;
    };

    const olderSave = tab.context.saveHideTunnelRequests(false);
    const newerSave = tab.context.saveFilterSafeFonts(true);
    newer.resolve(settingsResponse({ hideTunnelRequests: false, filterSafeFonts: true }));
    await newerSave;

    const expectedSettings = { hideTunnelRequests: false, filterSafeFonts: true };
    assert.deepEqual(tab.settings(), expectedSettings);
    assert.deepEqual(tab.toasts, [
      { message: 'Traffic display setting saved', type: 'success' }
    ]);

    older.resolve(olderResult === 'success'
      ? settingsResponse({ hideTunnelRequests: false, filterSafeFonts: false })
      : settingsResponse({}, { ok: false, error: 'older save failed' }));
    await olderSave;

    assert.deepEqual(tab.requestBodies, [
      { hideTunnelRequests: false },
      { filterSafeFonts: true }
    ]);
    assert.deepEqual(tab.settings(), expectedSettings);
    assert.equal(tab.toggles.hideTunnelRequestsToggle.checked, false);
    assert.equal(tab.toggles.filterSafeFontsToggle.checked, true);
    assert.deepEqual(tab.toasts, [
      { message: 'Traffic display setting saved', type: 'success' }
    ]);
  }
});

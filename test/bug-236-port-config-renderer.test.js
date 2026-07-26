import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { resolveProxyPortRange } from '../src/proxy/port-range.js';
import { Settings } from '../src/settings.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestJson(port, method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers: payload === null ? undefined : {
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

test('port config API keeps the persisted range separate from the active port', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-port-config-ui-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  settings.set('proxyPortRange', { minPort: 19000, maxPort: 19010 });
  const persistedRange = resolveProxyPortRange(settings);
  const proxy = {
    port: 19000,
    ...persistedRange,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  const apiPort = await listen(server);
  t.after(() => close(server));

  const loaded = await requestJson(apiPort, 'GET', '/api/port-config');
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(loaded.body, { proxyPort: 19000, minPort: 19000, maxPort: 19010 });

  const invalid = await requestJson(apiPort, 'POST', '/api/port-config', {
    minPort: 20000,
    maxPort: 19999
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.error, /minimum no greater than maximum/);
  assert.deepEqual(resolveProxyPortRange(new Settings(dataDir)), persistedRange);

  const saved = await requestJson(apiPort, 'POST', '/api/port-config', {
    minPort: 19100,
    maxPort: 19110
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body, {
    success: true,
    minPort: 19100,
    maxPort: 19110,
    note: 'Port changes take effect on next restart'
  });
  assert.equal(proxy.port, 19000);
  assert.deepEqual(resolveProxyPortRange(new Settings(dataDir)), { minPort: 19100, maxPort: 19110 });
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const configStart = rendererSource.indexOf('async function loadConfig()');
const configEnd = rendererSource.indexOf('let uiSettingsSaveGeneration = 0;', configStart);
const portStart = rendererSource.indexOf('let portConfigLoadGeneration = 0;');
const portEnd = rendererSource.indexOf('// ============ TLS PASSTHROUGH', portStart);
assert.notEqual(configStart, -1);
assert.notEqual(configEnd, -1);
assert.notEqual(portStart, -1);
assert.notEqual(portEnd, -1);

function rendererResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createRenderer(fetch) {
  const elements = {
    settingsMinPort: { value: '' },
    settingsMaxPort: { value: '' },
    settingsCaFingerprint: { textContent: '' },
    manualProxyPort: { textContent: '' }
  };
  const toasts = [];
  const context = {
    API_BASE: '',
    console,
    document: { getElementById: id => elements[id] || null },
    fetch,
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(
    `${rendererSource.slice(configStart, configEnd)}\n${rendererSource.slice(portStart, portEnd)}`,
    context
  );
  return { context, elements, toasts };
}

test('renderer loads the saved range without active-port race in either response order', async () => {
  for (const firstResponse of ['config', 'range']) {
    const configPending = deferred();
    const rangePending = deferred();
    const renderer = createRenderer(url => url.endsWith('/api/config')
      ? configPending.promise
      : rangePending.promise);

    const loading = renderer.context.loadConfig();
    const configResponse = rendererResponse({
      config: { proxyPort: 19000, certificateFingerprint: 'fingerprint' }
    });
    const rangeResponse = rendererResponse({ proxyPort: 19000, minPort: 19000, maxPort: 19010 });
    if (firstResponse === 'config') {
      configPending.resolve(configResponse);
      await Promise.resolve();
      rangePending.resolve(rangeResponse);
    } else {
      rangePending.resolve(rangeResponse);
      await Promise.resolve();
      configPending.resolve(configResponse);
    }
    await loading;

    assert.equal(renderer.elements.settingsMinPort.value, '19000', firstResponse);
    assert.equal(renderer.elements.settingsMaxPort.value, '19010', firstResponse);
    assert.equal(renderer.elements.manualProxyPort.textContent, 19000, firstResponse);
    assert.deepEqual(renderer.toasts, [], firstResponse);
  }
});

test('late range loads do not overwrite an in-progress user edit', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  const loading = renderer.context.loadPortConfig();

  renderer.elements.settingsMinPort.value = '20000';
  renderer.elements.settingsMaxPort.value = '20010';
  pending.resolve(rendererResponse({ proxyPort: 19000, minPort: 19000, maxPort: 19010 }));
  await loading;

  assert.equal(renderer.elements.settingsMinPort.value, '20000');
  assert.equal(renderer.elements.settingsMaxPort.value, '20010');
  assert.deepEqual(renderer.toasts, []);
});

test('a save invalidates an older range load with matching field snapshots', async () => {
  const oldLoad = deferred();
  const renderer = createRenderer((_url, options = {}) => {
    if (options.method === 'POST') {
      return Promise.resolve(rendererResponse({ success: true, minPort: 19100, maxPort: 19110 }));
    }
    return oldLoad.promise;
  });
  renderer.elements.settingsMinPort.value = '19100';
  renderer.elements.settingsMaxPort.value = '19110';

  const loading = renderer.context.loadPortConfig();
  await renderer.context.savePortConfig();
  oldLoad.resolve(rendererResponse({ proxyPort: 19000, minPort: 19000, maxPort: 19010 }));
  await loading;

  assert.equal(renderer.elements.settingsMinPort.value, '19100');
  assert.equal(renderer.elements.settingsMaxPort.value, '19110');
  assert.deepEqual(renderer.toasts, [{
    message: 'Port range saved (takes effect on restart)',
    type: 'success'
  }]);
});

test('reconnect loads stay blocked until every overlapping save settles', async () => {
  const firstSave = deferred();
  const secondSave = deferred();
  let getCount = 0;
  let postCount = 0;
  const renderer = createRenderer((_url, options = {}) => {
    if (options.method !== 'POST') {
      getCount++;
      return Promise.resolve(rendererResponse({ proxyPort: 19000, minPort: 19000, maxPort: 19010 }));
    }
    postCount++;
    return postCount === 1 ? firstSave.promise : secondSave.promise;
  });

  renderer.elements.settingsMinPort.value = '19100';
  renderer.elements.settingsMaxPort.value = '19110';
  const olderSaving = renderer.context.savePortConfig();
  renderer.elements.settingsMinPort.value = '19200';
  renderer.elements.settingsMaxPort.value = '19210';
  const newerSaving = renderer.context.savePortConfig();

  await renderer.context.loadPortConfig();
  assert.equal(getCount, 0);
  secondSave.resolve(rendererResponse({ success: true, minPort: 19200, maxPort: 19210 }));
  await newerSaving;
  await renderer.context.loadPortConfig();
  assert.equal(getCount, 0);

  firstSave.resolve(rendererResponse({ success: true, minPort: 19100, maxPort: 19110 }));
  await olderSaving;
  assert.equal(renderer.elements.settingsMinPort.value, '19200');
  assert.equal(renderer.elements.settingsMaxPort.value, '19210');
  assert.deepEqual(renderer.toasts, [{
    message: 'Port range saved (takes effect on restart)',
    type: 'success'
  }]);
});

test('renderer reports a port range load failure without changing the fields', async () => {
  const renderer = createRenderer(async () =>
    rendererResponse({ error: 'range unavailable' }, { ok: false, status: 503 }));

  await renderer.context.loadPortConfig();

  assert.equal(renderer.elements.settingsMinPort.value, '');
  assert.equal(renderer.elements.settingsMaxPort.value, '');
  assert.deepEqual(renderer.toasts, [{ message: 'Error: range unavailable', type: 'error' }]);
});

test('renderer validates port config failures and only confirms successful saves', async () => {
  const requests = [];
  const renderer = createRenderer(async (_url, options = {}) => {
    requests.push(options);
    return rendererResponse({ error: 'invalid range' }, { ok: false, status: 400 });
  });
  renderer.elements.settingsMinPort.value = '20000';
  renderer.elements.settingsMaxPort.value = '19000';

  await renderer.context.savePortConfig();
  assert.deepEqual(JSON.parse(requests[0].body), { minPort: '20000', maxPort: '19000' });
  assert.deepEqual(renderer.toasts, [{ message: 'Error: invalid range', type: 'error' }]);

  renderer.toasts.length = 0;
  renderer.elements.settingsMinPort.value = '19100';
  renderer.elements.settingsMaxPort.value = '19110';
  renderer.context.fetch = async () => rendererResponse({
    success: true,
    minPort: 19100,
    maxPort: 19110
  });
  await renderer.context.savePortConfig();

  assert.equal(renderer.elements.settingsMinPort.value, '19100');
  assert.equal(renderer.elements.settingsMaxPort.value, '19110');
  assert.deepEqual(renderer.toasts, [{
    message: 'Port range saved (takes effect on restart)',
    type: 'success'
  }]);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const blockStart = rendererSource.indexOf('function setSettingsStatus(');
const blockEnd = rendererSource.indexOf('// ============ PORT CONFIG', blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart);

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body
  };
}

function createHarness(fetch) {
  const status = {
    child: null,
    replaceChildren(child) {
      this.child = child;
    }
  };
  const elements = {
    autoRotateProxyOnError: { checked: false, disabled: false },
    bottingToolsProvider: { value: 'lemonprime', disabled: false },
    upstreamType: { value: 'none' },
    upstreamDetailsFields: { style: { display: 'block' } },
    upstreamDetailsLabel: { textContent: '' },
    upstreamDetails: { value: 'stale.example:8080', placeholder: '' },
    upstreamNoProxy: { value: 'stale.example' },
    upstreamStatus: status
  };
  const requests = [];
  const toasts = [];
  const context = {
    API_BASE: '',
    console,
    Object,
    document: {
      createElement: () => ({ style: {}, textContent: '' }),
      getElementById: id => elements[id] || null
    },
    fetch: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method || 'GET',
        ...(options.body === undefined ? {} : { body: options.body })
      });
      return fetch(url, options);
    },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(rendererSource.slice(blockStart, blockEnd), context);
  return { context, elements, requests, status, toasts };
}

test('proxy reconnect reads cannot replace settings saved after the read began', async () => {
  for (const setting of ['upstream', 'direct', 'auto-rotate', 'rotation']) {
    let releaseRead;
    const heldRead = new Promise(resolve => { releaseRead = resolve; });
    const proxy = { host: '127.0.0.1', port: 9, type: 'http', noProxy: [] };
    const ui = createHarness(async (_url, options) => options.method
      ? response({ success: true, enabled: true, provider: 'new-provider', upstreamProxy: proxy })
      : heldRead);
    const isAuto = setting === 'auto-rotate';
    const load = isAuto ? ui.context.loadAutoRotateProxyOnError() : ui.context.loadUpstreamProxy();
    if (isAuto) {
      ui.elements.autoRotateProxyOnError.checked = true;
      ui.elements.bottingToolsProvider.value = 'new-provider';
      await ui.context.saveAutoRotateProxyOnError();
    } else if (setting === 'rotation') {
      await ui.context.rotateBottingToolsProxy();
    } else {
      ui.elements.upstreamType.value = setting === 'direct' ? 'none' : 'http';
      ui.elements.upstreamDetails.value = '127.0.0.1:9';
      await ui.context.saveUpstreamProxy();
    }
    releaseRead(response(isAuto ? { enabled: false, provider: 'old-provider' }
      : { upstreamProxy: setting === 'direct' ? proxy : null }));
    await load;
    if (isAuto) {
      assert.equal(ui.elements.autoRotateProxyOnError.checked, true);
      assert.equal(ui.elements.bottingToolsProvider.value, 'new-provider');
      assert.equal(vm.runInContext('autoRotateProxyAuthoritative.enabled', ui.context), true);
    } else {
      assert.equal(ui.elements.upstreamType.value, setting === 'direct' ? 'none' : 'http', setting);
      assert.match(ui.status.child.textContent, setting === 'direct' ? /Direct connection/ : /127\.0\.0\.1:9/, setting);
    }
  }
});

test('proxy loaders skip pending writes and accept fresh reads after completion', async () => {
  for (const auto of [false, true]) {
    let releaseSave;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    const ui = createHarness(async (_url, options) => options.method ? heldSave
      : response(auto ? { enabled: true, provider: 'fresh' } : { upstreamProxy: null }));
    const save = auto ? ui.context.saveAutoRotateProxyOnError() : ui.context.saveUpstreamProxy();
    const load = () => auto ? ui.context.loadAutoRotateProxyOnError() : ui.context.loadUpstreamProxy();
    await load();
    assert.equal(ui.requests.length, 1);
    releaseSave(response({ success: true, enabled: false }));
    await save;
    await load();
    assert.equal(ui.requests.length, 2);
    if (auto) assert.equal(ui.elements.autoRotateProxyOnError.checked, true);
    else assert.equal(ui.elements.upstreamType.value, 'none');
  }
});

test('proxy loaders retain the newest read and supersede old reads on rotation events', async () => {
  for (const auto of [false, true]) {
    const releases = [];
    const ui = createHarness(() => new Promise(resolve => releases.push(resolve)));
    const load = () => auto ? ui.context.loadAutoRotateProxyOnError() : ui.context.loadUpstreamProxy();
    const older = load();
    const newer = load();
    const proxy = { host: 'current.test', port: 8080, type: 'http' };
    releases[1](response(auto ? { enabled: true, provider: 'current' } : { upstreamProxy: proxy }));
    await newer;
    releases[0](response(auto ? { enabled: false, provider: 'old' } : { upstreamProxy: null }));
    await older;
    if (auto) assert.equal(ui.elements.autoRotateProxyOnError.checked, true);
    else {
      assert.equal(ui.elements.upstreamDetails.value, 'current.test:8080');
      const stale = load();
      ui.context.handleProxyAutoRotateEvent({ status: 'success', upstreamProxy: { ...proxy, host: 'rotated.test' } });
      releases[2](response({ upstreamProxy: proxy }));
      await stale;
      assert.equal(ui.elements.upstreamDetails.value, 'rotated.test:8080');
    }
  }
});

test('loading a null upstream configuration explicitly renders direct mode', async () => {
  const ui = createHarness(async () => response({ upstreamProxy: null }));
  ui.elements.upstreamType.value = 'https';

  await ui.context.loadUpstreamProxy();

  assert.deepEqual(ui.requests, [{ url: '/api/upstream-proxy', method: 'GET' }]);
  assert.equal(ui.elements.upstreamType.value, 'none');
  assert.equal(ui.elements.upstreamDetailsFields.style.display, 'none');
  assert.equal(ui.elements.upstreamDetails.value, '');
  assert.equal(ui.elements.upstreamNoProxy.value, '');
  assert.equal(ui.status.child.textContent, 'Direct connection (no upstream proxy)');
  assert.deepEqual(ui.toasts, []);
});

test('a successful direct-mode change reports direct only after DELETE succeeds', async () => {
  const ui = createHarness(async () => response({ success: true }));

  await ui.context.saveUpstreamProxy();

  assert.deepEqual(ui.requests, [{ url: '/api/upstream-proxy', method: 'DELETE' }]);
  assert.equal(ui.status.child.textContent, 'Direct connection (no upstream proxy)');
  assert.deepEqual(ui.toasts, [{ message: 'Upstream proxy disabled', type: 'success' }]);
});

test('a failed direct-mode change restores the authoritative active proxy display', async () => {
  let requestCount = 0;
  const ui = createHarness(async () => {
    requestCount++;
    if (requestCount === 1) {
      return response({ error: 'disk full' }, { ok: false, status: 500 });
    }
    return response({
      upstreamProxy: {
        type: 'http',
        host: 'corp.proxy.test',
        port: 8080,
        auth: null,
        noProxy: ['localhost']
      }
    });
  });

  await ui.context.saveUpstreamProxy();

  assert.deepEqual(ui.requests, [
    { url: '/api/upstream-proxy', method: 'DELETE' },
    { url: '/api/upstream-proxy', method: 'GET' }
  ]);
  assert.equal(ui.elements.upstreamType.value, 'http');
  assert.equal(ui.elements.upstreamDetailsFields.style.display, 'block');
  assert.equal(ui.elements.upstreamDetails.value, 'corp.proxy.test:8080');
  assert.equal(ui.elements.upstreamNoProxy.value, 'localhost');
  assert.equal(ui.status.child.textContent, 'Active: HTTP proxy at corp.proxy.test:8080');
  assert.deepEqual(ui.toasts, [{ message: 'Error: disk full', type: 'error' }]);
});

test('upstream details parse IPv6 addresses without inventing a port delimiter', async () => {
  for (const scenario of [
    {
      type: 'https', details: '[2001:db8::1]',
      expected: { host: '[2001:db8::1]', port: 443 }
    },
    {
      type: 'http', details: 'user:secret@[2001:db8::2]:3128',
      expected: { host: '[2001:db8::2]', port: 3128, auth: 'user:secret' }
    },
    {
      type: 'socks5h', details: '2001:db8::3',
      expected: { host: '2001:db8::3', port: 1080 }
    }
  ]) {
    const ui = createHarness(async () => response({ success: true }));
    ui.elements.upstreamType.value = scenario.type;
    ui.elements.upstreamDetails.value = scenario.details;
    ui.elements.upstreamNoProxy.value = 'localhost, internal.test';

    await ui.context.saveUpstreamProxy();

    assert.equal(ui.requests.length, 1);
    const payload = JSON.parse(ui.requests[0].body);
    assert.deepEqual(
      JSON.parse(JSON.stringify(payload)),
      {
        host: scenario.expected.host,
        port: scenario.expected.port,
        auth: scenario.expected.auth || null,
        type: scenario.type,
        noProxy: ['localhost', 'internal.test']
      }
    );
    assert.match(ui.status.child.textContent, /\[2001:db8::[123]\]:\d+/);
  }
});

test('malformed or out-of-range upstream ports fail before the API request', async () => {
  for (const details of [
    'proxy.example:8080junk',
    'proxy.example:0',
    'proxy.example:65536',
    '[2001:db8::1]:443junk',
    '[2001:db8::1]trailing'
  ]) {
    const ui = createHarness(async () => {
      throw new Error('fetch must not run');
    });
    ui.elements.upstreamType.value = 'http';
    ui.elements.upstreamDetails.value = details;

    await ui.context.saveUpstreamProxy();

    assert.deepEqual(ui.requests, [], details);
    assert.equal(ui.toasts.length, 1);
    assert.equal(ui.toasts[0].type, 'error');
    assert.match(ui.toasts[0].message, /port|IPv6/i);
  }
});

test('loaded bare IPv6 upstreams round-trip with unambiguous brackets', () => {
  const ui = createHarness(async () => response({}));

  ui.context.updateUpstreamProxyUi({
    type: 'socks5',
    host: '2001:db8::5',
    port: 1080,
    auth: 'alice:secret',
    noProxy: []
  });

  assert.equal(ui.elements.upstreamDetails.value, 'alice:secret@[2001:db8::5]:1080');
  assert.equal(ui.status.child.textContent, 'Active: SOCKS5 proxy at [2001:db8::5]:1080');
});

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

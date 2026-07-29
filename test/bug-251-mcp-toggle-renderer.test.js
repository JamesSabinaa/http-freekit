import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const mcpStart = rendererSource.indexOf('let mcpAuthoritativeEnabled = null;');
const mcpEnd = rendererSource.indexOf('// ============ API SPECS', mcpStart);
assert.notEqual(mcpStart, -1);
assert.notEqual(mcpEnd, -1);

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
    mcpStatus: { textContent: '', style: {} },
    mcpSseEndpoint: { textContent: '' },
    mcpClientCount: { textContent: '' },
    mcpEnabledToggle: { checked: true, disabled: false },
    mcpClaudeConfig: { textContent: '' }
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
  vm.runInContext(rendererSource.slice(mcpStart, mcpEnd), context);
  return {
    context,
    elements,
    toasts,
    state() {
      return JSON.parse(JSON.stringify(vm.runInContext(`({
        mcpAuthoritativeEnabled,
        mcpToggleInFlight
      })`, context)));
    }
  };
}

test('failed MCP enable restores the authoritative unchecked state', async () => {
  let requestCount = 0;
  const renderer = createRenderer(async (_url, options = {}) => {
    requestCount++;
    if (options.method !== 'POST') return rendererResponse({ enabled: false });
    throw new Error('Management API returned HTTP 503');
  });

  await renderer.context.loadMcpStatus();
  renderer.elements.mcpEnabledToggle.checked = true;
  const toggling = renderer.context.toggleMcp(true);

  assert.equal(renderer.elements.mcpEnabledToggle.disabled, true);
  await toggling;

  assert.equal(requestCount, 2);
  assert.equal(renderer.elements.mcpEnabledToggle.checked, false);
  assert.equal(renderer.elements.mcpEnabledToggle.disabled, false);
  assert.deepEqual(renderer.state(), {
    mcpAuthoritativeEnabled: false,
    mcpToggleInFlight: null
  });
  assert.deepEqual(renderer.toasts, [{
    message: 'Error: Management API returned HTTP 503',
    type: 'error'
  }]);
});

test('failed MCP disable rejects an invalid success payload and restores checked state', async () => {
  const renderer = createRenderer(async (_url, options = {}) => {
    if (options.method !== 'POST') return rendererResponse({ enabled: true });
    return rendererResponse({ success: true, enabled: true });
  });

  await renderer.context.loadMcpStatus();
  renderer.elements.mcpEnabledToggle.checked = false;
  await renderer.context.toggleMcp(false);

  assert.equal(renderer.elements.mcpEnabledToggle.checked, true);
  assert.equal(renderer.elements.mcpEnabledToggle.disabled, false);
  assert.deepEqual(renderer.state(), {
    mcpAuthoritativeEnabled: true,
    mcpToggleInFlight: null
  });
  assert.deepEqual(renderer.toasts, [{
    message: 'Error: MCP toggle returned an invalid response',
    type: 'error'
  }]);
});

test('successful MCP enable and disable keep the confirmed state and refresh status', async () => {
  for (const requestedEnabled of [true, false]) {
    const initialEnabled = !requestedEnabled;
    let statusRequests = 0;
    const posts = [];
    const renderer = createRenderer(async (_url, options = {}) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return rendererResponse({ success: true, enabled: requestedEnabled });
      }
      statusRequests++;
      return rendererResponse({
        enabled: statusRequests === 1 ? initialEnabled : requestedEnabled,
        sseEndpoint: requestedEnabled ? 'http://localhost/mcp/sse' : null,
        connectedClients: requestedEnabled ? 1 : 0
      });
    });

    await renderer.context.loadMcpStatus();
    renderer.elements.mcpEnabledToggle.checked = requestedEnabled;
    await renderer.context.toggleMcp(requestedEnabled);

    assert.deepEqual(posts, [{ enabled: requestedEnabled }]);
    assert.equal(statusRequests, 2);
    assert.equal(renderer.elements.mcpEnabledToggle.checked, requestedEnabled);
    assert.equal(renderer.elements.mcpEnabledToggle.disabled, false);
    assert.equal(renderer.elements.mcpStatus.textContent, requestedEnabled ? 'Running' : 'Stopped');
    assert.deepEqual(renderer.toasts, [{
      message: requestedEnabled ? 'MCP server enabled' : 'MCP server disabled',
      type: 'success'
    }]);
  }
});

test('degraded MCP status is visible with its cleanup failure reason', async () => {
  const renderer = createRenderer(async () => rendererResponse({
    enabled: true,
    degraded: true,
    degradedReason: 'stdio cleanup failed',
    connectedClients: 1
  }));

  await renderer.context.loadMcpStatus();

  assert.equal(renderer.elements.mcpStatus.textContent, 'Degraded');
  assert.equal(renderer.elements.mcpStatus.style.color, '#d99a3e');
  assert.equal(renderer.elements.mcpStatus.title, 'stdio cleanup failed');
  assert.equal(renderer.elements.mcpEnabledToggle.checked, true);
});

test('a degraded toggle failure refreshes the authoritative status immediately', async () => {
  let statusRequests = 0;
  const renderer = createRenderer(async (_url, options = {}) => {
    if (options.method === 'POST') {
      return rendererResponse({
        error: 'MCP cleanup failed',
        degraded: true,
        enabled: true,
        degradedReason: 'stdio close failed'
      }, { ok: false });
    }
    statusRequests++;
    return rendererResponse(statusRequests === 1
      ? { enabled: true }
      : {
          enabled: true,
          degraded: true,
          degradedReason: 'stdio close failed'
        });
  });

  await renderer.context.loadMcpStatus();
  await renderer.context.toggleMcp(false);

  assert.equal(statusRequests, 2);
  assert.equal(renderer.elements.mcpStatus.textContent, 'Degraded');
  assert.equal(renderer.elements.mcpStatus.title, 'stdio close failed');
  assert.equal(renderer.elements.mcpEnabledToggle.checked, true);
  assert.deepEqual(renderer.toasts, [{ message: 'Error: MCP cleanup failed', type: 'error' }]);
});

test('an in-flight MCP toggle disables the checkbox and ignores a duplicate inversion', async () => {
  const pendingToggle = deferred();
  let statusRequests = 0;
  let postRequests = 0;
  const renderer = createRenderer(async (_url, options = {}) => {
    if (options.method === 'POST') {
      postRequests++;
      return pendingToggle.promise;
    }
    statusRequests++;
    return rendererResponse({ enabled: statusRequests > 1 });
  });

  await renderer.context.loadMcpStatus();
  const firstToggle = renderer.context.toggleMcp(true);
  assert.equal(renderer.elements.mcpEnabledToggle.checked, true);
  assert.equal(renderer.elements.mcpEnabledToggle.disabled, true);

  renderer.elements.mcpEnabledToggle.checked = false;
  const duplicateToggle = renderer.context.toggleMcp(false);
  await duplicateToggle;
  assert.equal(postRequests, 1);
  assert.equal(renderer.elements.mcpEnabledToggle.checked, true);
  assert.equal(renderer.elements.mcpEnabledToggle.disabled, true);

  pendingToggle.resolve(rendererResponse({ success: true, enabled: true }));
  await firstToggle;

  assert.equal(statusRequests, 2);
  assert.equal(postRequests, 1);
  assert.equal(renderer.elements.mcpEnabledToggle.checked, true);
  assert.equal(renderer.elements.mcpEnabledToggle.disabled, false);
  assert.deepEqual(renderer.toasts, [{ message: 'MCP server enabled', type: 'success' }]);
});

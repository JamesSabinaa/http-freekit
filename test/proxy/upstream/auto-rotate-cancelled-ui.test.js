import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
const blockStart = rendererSource.indexOf('function setSettingsStatus(');
const blockEnd = rendererSource.indexOf('async function loadUpstreamProxy(', blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart);

function createHarness() {
  const status = {
    child: null,
    replaceChildren(child) {
      this.child = child;
    }
  };
  const elements = {
    upstreamType: { value: 'http' },
    upstreamDetailsFields: { style: { display: 'block' } },
    upstreamDetailsLabel: { textContent: '' },
    upstreamDetails: { value: 'stale.proxy.test:8080', placeholder: '' },
    upstreamNoProxy: { value: 'stale.test' },
    upstreamStatus: status
  };
  const toasts = [];
  const context = {
    Object,
    document: {
      createElement: () => ({ style: {}, textContent: '' }),
      getElementById: id => elements[id] || null
    },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(rendererSource.slice(blockStart, blockEnd), context);
  return { context, elements, status, toasts };
}

test('cancelled auto-rotation applies the authoritative active proxy and reports neutrally', () => {
  const ui = createHarness();

  ui.context.handleProxyAutoRotateEvent({
    status: 'cancelled',
    provider: 'discarded-provider',
    upstreamProxy: {
      type: 'https',
      host: 'manual.proxy.test',
      port: 9443,
      auth: 'user:secret',
      noProxy: ['localhost', 'internal.test']
    }
  });

  assert.equal(ui.elements.upstreamType.value, 'https');
  assert.equal(ui.elements.upstreamDetailsFields.style.display, 'block');
  assert.equal(ui.elements.upstreamDetails.value, 'user:secret@manual.proxy.test:9443');
  assert.equal(ui.elements.upstreamNoProxy.value, 'localhost, internal.test');
  assert.equal(ui.status.child.textContent, 'Active: HTTPS proxy at manual.proxy.test:9443');
  assert.deepEqual(ui.toasts, [{
    message: 'Auto proxy rotation cancelled; current proxy settings retained',
    type: 'info'
  }]);
});

test('cancelled auto-rotation treats an explicit null proxy as authoritative direct mode', () => {
  const ui = createHarness();

  ui.context.handleProxyAutoRotateEvent({
    status: 'cancelled',
    upstreamProxy: null
  });

  assert.equal(ui.elements.upstreamType.value, 'none');
  assert.equal(ui.elements.upstreamDetailsFields.style.display, 'none');
  assert.equal(ui.elements.upstreamDetails.value, '');
  assert.equal(ui.elements.upstreamNoProxy.value, '');
  assert.equal(ui.status.child.textContent, 'Direct connection (no upstream proxy)');
  assert.deepEqual(ui.toasts, [{
    message: 'Auto proxy rotation cancelled; current proxy settings retained',
    type: 'info'
  }]);
});

test('cancelled auto-rotation ignores missing or inherited proxy payloads', () => {
  for (const message of [
    { status: 'cancelled' },
    Object.assign(Object.create({ upstreamProxy: null }), { status: 'cancelled' })
  ]) {
    const ui = createHarness();

    ui.context.handleProxyAutoRotateEvent(message);

    assert.equal(ui.elements.upstreamType.value, 'http');
    assert.equal(ui.elements.upstreamDetailsFields.style.display, 'block');
    assert.equal(ui.elements.upstreamDetails.value, 'stale.proxy.test:8080');
    assert.equal(ui.elements.upstreamNoProxy.value, 'stale.test');
    assert.equal(ui.status.child, null);
    assert.deepEqual(ui.toasts, [{
      message: 'Auto proxy rotation cancelled; current proxy settings retained',
      type: 'info'
    }]);
  }
});

test('started, success, and error auto-rotation feedback remains unchanged', () => {
  const ui = createHarness();

  ui.context.handleProxyAutoRotateEvent({ status: 'started', reason: 'Proxy reset' });
  ui.context.handleProxyAutoRotateEvent({
    status: 'success',
    provider: 'lemonprime',
    upstreamProxy: {
      type: 'http',
      host: 'rotated.proxy.test',
      port: 8181,
      noProxy: []
    }
  });
  ui.context.handleProxyAutoRotateEvent({ status: 'error', error: 'lookup failed' });

  assert.equal(ui.elements.upstreamDetails.value, 'rotated.proxy.test:8181');
  assert.equal(ui.status.child.textContent, 'Active: HTTP proxy at rotated.proxy.test:8181 from lemonprime');
  assert.deepEqual(ui.toasts, [
    { message: 'Proxy reset detected; rotating BottingTools proxy...', type: 'success' },
    { message: 'BottingTools proxy auto-rotated', type: 'success' },
    { message: 'Auto proxy rotation failed: lookup failed', type: 'error' }
  ]);
});

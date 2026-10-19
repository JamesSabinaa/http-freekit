import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function harness() {
  const source = fs.readFileSync('src/ui/app.js', 'utf8');
  const start = source.indexOf('    let generatorExportInProgress =');
  const end = source.indexOf('    // ============ UPSTREAM PROXY', start);
  assert.ok(start >= 0 && end > start);
  let respond;
  let calls = 0;
  const toasts = [];
  const attributes = new Map();
  const button = {
    disabled: false,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key)
  };
  const context = vm.createContext({
    API_BASE: '',
    document: { getElementById: () => button },
    fetch: () => { calls++; return new Promise(resolve => { respond = resolve; }); },
    toast: (message, type) => toasts.push({ message, type })
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    run: () => context.exportHarToGenerator(), button, attributes, toasts,
    calls: () => calls,
    respond: (data, ok = true) => respond({ ok, status: ok ? 200 : 500, json: async () => data })
  };
}

test('Generator export immediately reports progress and prevents duplicate launches', async () => {
  const h = harness();
  const pending = h.run();
  assert.equal(h.button.disabled, true);
  assert.equal(h.attributes.get('aria-busy'), 'true');
  assert.equal(h.toasts[0].message, 'Opening Generator…');
  await h.run();
  assert.equal(h.calls(), 1);
  assert.equal(h.toasts.some(x => x.type === 'success'), false);
  h.respond({ success: true, opened: true, requestCount: 2 });
  await pending;
  assert.deepEqual(h.toasts.at(-1), { message: 'Opened 2 requests in Generator', type: 'success' });
  assert.equal(h.button.disabled, false);
  assert.equal(h.attributes.has('aria-busy'), false);
});

test('unconfirmed startup never produces Opened and leaves the button retryable', async () => {
  const h = harness();
  const pending = h.run();
  h.respond({ success: true, requestCount: 2 });
  await pending;
  assert.equal(h.toasts.some(x => x.type === 'success'), false);
  assert.match(h.toasts.at(-1).message, /did not confirm its window opened/);
  assert.equal(h.button.disabled, false);
  const retry = h.run();
  assert.equal(h.calls(), 2);
  h.respond({ success: false, error: 'Missing PySide6' }, false);
  await retry;
  assert.match(h.toasts.at(-1).message, /Missing PySide6/);
  assert.equal(h.button.disabled, false);
});

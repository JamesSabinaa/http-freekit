import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('let autoRotateProxyAuthoritative');
const end = source.indexOf('function handleProxyAutoRotateEvent', start);
assert.ok(start >= 0 && end > start);

function createHarness(fetch) {
  const checkbox = { checked: false, disabled: false };
  const provider = { value: 'lemonprime', disabled: false };
  const toasts = [];
  const context = {
    API_BASE: '',
    fetch,
    console,
    document: { getElementById: id => id === 'autoRotateProxyOnError' ? checkbox : provider },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.api = {
    load: loadAutoRotateProxyOnError,
    save: saveAutoRotateProxyOnError
  };`, context);
  return { checkbox, provider, toasts, api: context.api };
}

test('silent provider autosave failure restores authoritative controls and reports the error', async () => {
  let rejectSave;
  let calls = 0;
  const harness = createHarness(async (_url, options) => {
    calls++;
    if (!options) return { json: async () => ({ enabled: true, provider: 'lemonprime' }) };
    return await new Promise((_, reject) => { rejectSave = reject; });
  });
  await harness.api.load();
  harness.provider.value = 'brightdata';
  const first = harness.api.save(false);
  const second = harness.api.save(false);
  assert.equal(calls, 2, 'concurrent saves share the active request');
  assert.equal(harness.checkbox.disabled, true);
  assert.equal(harness.provider.disabled, true);
  rejectSave(new Error('settings storage is read-only'));
  await Promise.all([first, second]);

  assert.equal(harness.checkbox.checked, true);
  assert.equal(harness.provider.value, 'lemonprime');
  assert.equal(harness.checkbox.disabled, false);
  assert.equal(harness.provider.disabled, false);
  assert.deepEqual(harness.toasts, [{
    message: 'Auto rotate setting failed: settings storage is read-only',
    type: 'error'
  }]);
});

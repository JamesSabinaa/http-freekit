import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const API_BASE =');
const end = source.indexOf('// ============ WEBSOCKET ============', start);
assert.ok(start >= 0 && end > start);

function createHarness(payload) {
  const nativeFetch = async () => ({
    ok: false,
    status: 409,
    clone: () => ({ json: async () => payload }),
    json: async () => payload
  });
  const window = {
    location: {
      hostname: '127.0.0.1',
      port: '8001',
      search: '',
      href: 'http://127.0.0.1:8001/',
      origin: 'http://127.0.0.1:8001'
    },
    fetch: nativeFetch
  };
  const context = {
    window,
    fetch: (...args) => window.fetch(...args),
    URL,
    URLSearchParams,
    Headers,
    Request
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.readJson = fetchManagementJson;`, context);
  return context;
}

test('management fetch errors retain their response and structured payload for recovery consumers', async () => {
  const payload = {
    error: 'Remove the legacy CA before Stop',
    code: 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED',
    deviceIds: ['device-1']
  };
  const context = createHarness(payload);

  await assert.rejects(context.window.fetch('/api/interceptors/android-adb/deactivate'), error => {
    assert.equal(error.status, 409);
    assert.strictEqual(error.payload, payload);
    assert.equal(error.response.status, 409);
    return true;
  });

  const structured = await context.readJson('/api/interceptors/android-adb/deactivate');
  assert.equal(structured.response.status, 409);
  assert.strictEqual(structured.data, payload);
});

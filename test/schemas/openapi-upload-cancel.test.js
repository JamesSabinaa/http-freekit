import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const uploadStart = source.indexOf('async function readApiSpecUploadResponse');
const uploadEnd = source.indexOf('async function removeApiSpec', uploadStart);
assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, 'OpenAPI upload functions must be present');
const uploadSource = source.slice(uploadStart, uploadEnd);

function createHarness({ promptValue, response } = {}) {
  const fetches = [];
  const toasts = [];
  let reloads = 0;
  let clicks = 0;
  const input = {
    type: '',
    accept: '',
    onchange: null,
    click() { clicks++; }
  };
  const context = {
    API_BASE: '',
    document: {
      createElement(tag) {
        assert.equal(tag, 'input');
        return input;
      }
    },
    prompt: () => promptValue,
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return response || {
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      };
    },
    toast: (message, type) => toasts.push({ message, type }),
    loadApiSpecs: () => { reloads++; }
  };
  vm.createContext(context);
  vm.runInContext(`${uploadSource}\nglobalThis.beginUpload = uploadApiSpec;`, context);
  context.beginUpload();
  assert.equal(clicks, 1);

  async function select(spec = { openapi: '3.1.0', info: { title: 'Pet API' }, paths: {} }) {
    await input.onchange({
      target: {
        files: [{ name: 'pet-api.json', text: async () => JSON.stringify(spec) }]
      }
    });
  }

  return {
    context,
    fetches,
    input,
    select,
    toasts,
    get reloads() { return reloads; }
  };
}

test('OpenAPI upload source checks prompt cancellation before fetching', () => {
  const cancelIndex = uploadSource.indexOf('if (baseUrl === null) return;');
  const fetchIndex = uploadSource.indexOf("fetch(API_BASE + '/api/specs'");
  assert.ok(cancelIndex >= 0 && fetchIndex > cancelIndex);
});

test('canceling the OpenAPI base URL prompt performs no upload, toast, or reload', async () => {
  const harness = createHarness({ promptValue: null });
  await harness.select();

  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.toasts, []);
  assert.equal(harness.reloads, 0);
});

test('submitting an intentionally empty base URL preserves the empty string', async () => {
  const harness = createHarness({ promptValue: '' });
  await harness.select();

  assert.equal(harness.fetches.length, 1);
  const payload = JSON.parse(harness.fetches[0].options.body);
  assert.equal(payload.baseUrl, '');
  assert.equal(payload.title, 'Pet API');
  assert.deepEqual(harness.toasts, [
    { message: 'API spec loaded: Pet API', type: 'success' }
  ]);
  assert.equal(harness.reloads, 1);
});

test('a successful OpenAPI response reports success and reloads the list', async () => {
  const harness = createHarness({
    promptValue: 'https://api.example.test',
    response: {
      ok: true,
      status: 200,
      json: async () => ({ success: true, spec: { id: 'spec-1' } })
    }
  });
  await harness.select();

  assert.equal(harness.fetches.length, 1);
  assert.equal(JSON.parse(harness.fetches[0].options.body).baseUrl, 'https://api.example.test');
  assert.deepEqual(harness.toasts, [
    { message: 'API spec loaded: Pet API', type: 'success' }
  ]);
  assert.equal(harness.reloads, 1);
});

test('a failed OpenAPI response reports its error without success or reload', async () => {
  const harness = createHarness({
    promptValue: 'https://api.example.test',
    response: {
      ok: false,
      status: 422,
      json: async () => ({ error: 'Spec was rejected' })
    }
  });
  await harness.select();

  assert.equal(harness.fetches.length, 1);
  assert.deepEqual(harness.toasts, [
    { message: 'Failed to load spec: Spec was rejected', type: 'error' }
  ]);
  assert.equal(harness.reloads, 0);
});

test('an HTTP-success response without API success stays on the failure path', async () => {
  const harness = createHarness({
    promptValue: 'https://api.example.test',
    response: {
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: 'Upload was not accepted' })
    }
  });
  await harness.select();

  assert.deepEqual(harness.toasts, [
    { message: 'Failed to load spec: Upload was not accepted', type: 'error' }
  ]);
  assert.equal(harness.reloads, 0);
});

test('failed OpenAPI responses without JSON use their HTTP status', async () => {
  const harness = createHarness({
    promptValue: 'https://api.example.test',
    response: {
      ok: false,
      status: 503,
      json: async () => { throw new Error('not JSON'); }
    }
  });
  await harness.select();

  assert.deepEqual(harness.toasts, [
    { message: 'Failed to load spec: API spec upload failed with HTTP 503', type: 'error' }
  ]);
  assert.equal(harness.reloads, 0);
});

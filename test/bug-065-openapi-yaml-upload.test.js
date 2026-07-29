import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as jsyaml from 'js-yaml';

const repoRoot = process.cwd();
const source = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'app.js'), 'utf8');
const uploadStart = source.indexOf('async function readApiSpecUploadResponse');
const uploadEnd = source.indexOf('async function removeApiSpec', uploadStart);
assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, 'OpenAPI upload functions must be present');
const uploadSource = source.slice(uploadStart, uploadEnd);

function createHarness({ parser = jsyaml } = {}) {
  const fetches = [];
  const prompts = [];
  const toasts = [];
  let reloads = 0;
  const input = { click() {}, onchange: null };
  const context = {
    API_BASE: '',
    jsyaml: parser,
    document: { createElement: () => input },
    prompt(message, defaultValue) {
      prompts.push({ message, defaultValue });
      return defaultValue;
    },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return {
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

  async function select(name, text) {
    await input.onchange({
      target: { files: [{ name, text: async () => text }] }
    });
  }

  return {
    fetches,
    input,
    prompts,
    select,
    toasts,
    get reloads() { return reloads; }
  };
}

test('valid YAML OpenAPI documents are parsed and uploaded as structured JSON', async () => {
  const harness = createHarness();
  await harness.select('pet-api.yaml', `
openapi: 3.1.0
info:
  title: Pet YAML API
servers:
  - url: https://pets.example.test
paths:
  /pets/{id}:
    get:
      operationId: getPet
`);

  assert.equal(harness.fetches.length, 1);
  const payload = JSON.parse(harness.fetches[0].options.body);
  assert.equal(payload.title, 'Pet YAML API');
  assert.equal(payload.baseUrl, 'https://pets.example.test');
  assert.equal(payload.spec.paths['/pets/{id}'].get.operationId, 'getPet');
  assert.equal(harness.prompts[0].defaultValue, 'https://pets.example.test');
  assert.deepEqual(harness.toasts, [
    { message: 'API spec loaded: Pet YAML API', type: 'success' }
  ]);
  assert.equal(harness.reloads, 1);
});

test('the short .yml extension is parsed as YAML', async () => {
  const harness = createHarness();
  await harness.select('swagger.YML', 'swagger: "2.0"\ninfo:\n  title: Legacy API\npaths: {}\n');

  assert.equal(harness.fetches.length, 1);
  assert.equal(JSON.parse(harness.fetches[0].options.body).spec.swagger, '2.0');
});

test('invalid YAML and scalar documents fail before prompting or uploading', async t => {
  for (const [name, text] of [
    ['invalid.yaml', 'openapi: [unterminated'],
    ['scalar.yml', 'just a string']
  ]) {
    await t.test(name, async () => {
      const harness = createHarness();
      await harness.select(name, text);

      assert.equal(harness.fetches.length, 0);
      assert.equal(harness.prompts.length, 0);
      assert.equal(harness.reloads, 0);
      assert.equal(harness.toasts.length, 1);
      assert.equal(harness.toasts[0].type, 'error');
      assert.match(harness.toasts[0].message, /^Failed to load spec: /);
    });
  }
});

test('a missing YAML browser parser reports a load error without an upload', async () => {
  const harness = createHarness({ parser: null });
  await harness.select('pet-api.yaml', 'openapi: 3.1.0\npaths: {}\n');

  assert.equal(harness.fetches.length, 0);
  assert.deepEqual(harness.toasts, [
    { message: 'Failed to load spec: YAML parser is unavailable', type: 'error' }
  ]);
});

test('the server exposes the packaged YAML bundle before the application script', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'src', 'index.js'), 'utf8');
  const html = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'index.html'), 'utf8');

  assert.match(indexSource, /node_modules', 'js-yaml', 'dist', 'browser'/);
  assert.match(indexSource, /api\.app\.use\('\/vendor\/js-yaml', express\.static\(JS_YAML_DIR\)\)/);
  const yamlScript = html.indexOf('/vendor/js-yaml/js-yaml.umd.min.js');
  const monacoLoader = html.indexOf('/vendor/monaco/vs/loader.js');
  const appScript = html.indexOf('/app.js');
  assert.ok(yamlScript >= 0 && yamlScript < monacoLoader && monacoLoader < appScript);
});

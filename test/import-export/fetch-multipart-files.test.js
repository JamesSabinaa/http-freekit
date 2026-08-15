import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { generateExportSnippet } from '../../src/ui/request-export.js';

function multipartRequest(formFields) {
  return {
    method: 'POST',
    url: 'https://example.test/upload',
    bodyType: 'multipart',
    requestHeaders: { 'X-Export-Test': 'fetch multipart' },
    formFields
  };
}

function executeFetchSnippet(request, selectedFiles, { hasInput = true } = {}) {
  const state = {
    appendCalls: [],
    fetchCalls: [],
    querySelectors: []
  };

  class FormDataStub {
    constructor() {
      state.formData = this;
    }

    append(...args) {
      state.appendCalls.push(args);
    }
  }

  const context = vm.createContext({
    FormData: FormDataStub,
    document: {
      querySelector(selector) {
        state.querySelectors.push(selector);
        return hasInput ? { files: selectedFiles } : null;
      }
    },
    async fetch(url, options) {
      state.fetchCalls.push({ url, options });
      return { status: 204, text: async () => '' };
    },
    console: { log() {} }
  });
  const snippet = generateExportSnippet(request, 'javascript-fetch');
  const completion = vm.runInContext(`(async () => {\n${snippet}\n})()`, context);
  return { completion, snippet, state };
}

test('Fetch multipart export maps distinct selected files to file parts in source order', async () => {
  const firstFile = { id: 'first selected File' };
  const secondFile = { id: 'second selected File' };
  const unusedFile = { id: 'unused selected File' };
  const duplicateFileFieldName = 'upload"\\name';
  const request = multipartRequest([
    { key: 'tag', value: 'first text' },
    { key: duplicateFileFieldName, type: 'file', fileName: 'first.bin' },
    { key: 'tag', value: 'second text' },
    { key: duplicateFileFieldName, type: 'file', fileName: 'second.bin' },
    { key: 'scalar', value: 'last text' }
  ]);

  const { completion, snippet, state } = executeFetchSnippet(
    request,
    [firstFile, secondFile, unusedFile]
  );
  await completion;

  assert.deepEqual(
    snippet.match(/selectedFiles\[\d+\]/g),
    ['selectedFiles[0]', 'selectedFiles[1]']
  );
  assert.deepEqual(state.querySelectors, ['input[type="file"]']);
  assert.deepEqual(state.appendCalls, [
    ['tag', 'first text'],
    [duplicateFileFieldName, firstFile, 'first.bin'],
    ['tag', 'second text'],
    [duplicateFileFieldName, secondFile, 'second.bin'],
    ['scalar', 'last text']
  ]);
  assert.equal(state.fetchCalls.length, 1);
  assert.equal(state.fetchCalls[0].url, request.url);
  assert.equal(state.fetchCalls[0].options.method, 'POST');
  assert.equal(state.fetchCalls[0].options.headers['X-Export-Test'], 'fetch multipart');
  assert.equal(state.fetchCalls[0].options.body, state.formData);
});

test('Fetch multipart export fails before building or sending when selections are insufficient', async t => {
  const request = multipartRequest([
    { key: 'upload', type: 'file', fileName: 'first.bin' },
    { key: 'tag', value: 'between files' },
    { key: 'upload', type: 'file', fileName: 'second.bin' }
  ]);

  for (const scenario of [
    { name: 'only one selected file', selectedFiles: [{ id: 'only file' }] },
    { name: 'no file input', selectedFiles: [], hasInput: false }
  ]) {
    await t.test(scenario.name, async () => {
      const { completion, state } = executeFetchSnippet(request, scenario.selectedFiles, scenario);
      await assert.rejects(
        completion,
        /Select at least 2 files in captured multipart part order before running this snippet\./
      );
      assert.deepEqual(state.appendCalls, []);
      assert.deepEqual(state.fetchCalls, []);
    });
  }
});

test('Fetch multipart export preserves scalar-only and ordinary single-file requests', async () => {
  const scalarRequest = multipartRequest([
    { key: 'tag', value: 'one' },
    { key: 'tag', value: 'two' }
  ]);
  const scalarRun = executeFetchSnippet(scalarRequest, [], { hasInput: false });
  await scalarRun.completion;
  assert.deepEqual(scalarRun.state.querySelectors, []);
  assert.deepEqual(scalarRun.state.appendCalls, [['tag', 'one'], ['tag', 'two']]);
  assert.equal(scalarRun.state.fetchCalls.length, 1);

  const selectedFile = { id: 'single selected File' };
  const singleFileRequest = multipartRequest([
    { key: 'description', value: 'single upload' },
    { key: 'document', type: 'file', fileName: 'report "final".pdf' }
  ]);
  const singleRun = executeFetchSnippet(singleFileRequest, [selectedFile]);
  await singleRun.completion;
  assert.deepEqual(singleRun.state.appendCalls, [
    ['description', 'single upload'],
    ['document', selectedFile, 'report "final".pdf']
  ]);
  assert.equal(singleRun.state.fetchCalls.length, 1);
});

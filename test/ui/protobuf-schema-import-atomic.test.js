import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import protobuf from 'protobufjs';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const sectionStart = source.indexOf('const PROTOBUF_SCHEMA_STORAGE_KEY');
const sectionEnd = source.indexOf('function updateProtobufTypeSelect', sectionStart);
const storageKey = 'http-freekit-protobuf-schemas';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function schemaFile(name, content) {
  return { name, text: async () => content };
}

function protobufImportContext(initialFiles, durableBytes = JSON.stringify(initialFiles)) {
  const durable = new Map([[storageKey, durableBytes]]);
  const writes = [];
  const toasts = [];
  let input;
  let refreshes = 0;
  const context = {
    window: { protobuf },
    document: {
      createElement() {
        input = { click() {} };
        return input;
      },
      getElementById() { return null; }
    },
    safeLocalStorageGet: key => durable.get(key) ?? null,
    safeLocalStorageSet: (key, value) => {
      writes.push([key, value]);
      durable.set(key, value);
      return true;
    },
    safeLocalStorageRemove: key => durable.delete(key),
    quarantineRendererStorageCorruptionGroup: () => true,
    hasRendererStorageCorruption: () => false,
    registerRendererStorageCorruption() {},
    toast: (message, type) => toasts.push({ message, type }),
    renderDetailCards() { refreshes++; },
    renderBodyViewer() { refreshes++; },
    isSelectedTrafficRequest: () => false,
    standaloneBodyViewers: {},
    bodySchemaTypeOverrides: {},
    selectedRequestId: null
  };
  vm.createContext(context);
  vm.runInContext(
    `var protobufSchemaFiles = ${JSON.stringify(initialFiles)};` +
      'var protobufRoot = null; var protobufSchemaError = "";\n' +
      source.slice(sectionStart, sectionEnd),
    context
  );
  context.rebuildProtobufRoot();
  return {
    context,
    durable,
    input: () => input,
    refreshes: () => refreshes,
    toasts,
    writes
  };
}

function liveFiles(context) {
  return plain(vm.runInContext('protobufSchemaFiles', context));
}

function liveRoot(context) {
  return vm.runInContext('protobufRoot', context);
}

test('malformed protobuf replacement preserves the prior root, files, and durable bytes', async () => {
  const initialFiles = [{
    name: 'model.proto',
    content: 'syntax = "proto3"; package demo; message Working { string value = 1; }'
  }];
  const durableBytes = JSON.stringify(initialFiles, null, 2);
  const ui = protobufImportContext(initialFiles, durableBytes);
  const priorRoot = liveRoot(ui.context);

  ui.context.importProtobufSchemas();
  await ui.input().onchange({
    target: {
      files: [schemaFile(
        'model.proto',
        'syntax = "proto3"; package demo; message Broken { string value = ; }'
      )]
    }
  });

  assert.strictEqual(liveRoot(ui.context), priorRoot);
  assert.deepEqual(liveFiles(ui.context), initialFiles);
  assert.equal(vm.runInContext('protobufSchemaError', ui.context), '');
  assert.equal(ui.durable.get(storageKey), durableBytes);
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.refreshes(), 0);
  assert.deepEqual(ui.toasts.map(entry => entry.type), ['error']);
  assert.match(ui.toasts[0].message, /^Schema import failed:/);
  assert.doesNotMatch(ui.toasts[0].message, /^Imported /);
  assert.ok(priorRoot.lookupType('demo.Working'));
});

test('a later malformed file rejects an otherwise valid multi-schema candidate atomically', async () => {
  const initialFiles = [{
    name: 'existing.proto',
    content: 'syntax = "proto3"; package demo; message Existing { int32 id = 1; }'
  }];
  const durableBytes = JSON.stringify(initialFiles);
  const ui = protobufImportContext(initialFiles, durableBytes);
  const priorRoot = liveRoot(ui.context);

  ui.context.importProtobufSchemas();
  await ui.input().onchange({
    target: {
      files: [
        schemaFile(
          'valid.proto',
          'syntax = "proto3"; package demo; message Candidate { string value = 1; }'
        ),
        schemaFile(
          'broken.proto',
          'syntax = "proto3"; package demo; message Broken { repeated string values = nope; }'
        )
      ]
    }
  });

  assert.strictEqual(liveRoot(ui.context), priorRoot);
  assert.deepEqual(liveFiles(ui.context), initialFiles);
  assert.equal(ui.durable.get(storageKey), durableBytes);
  assert.equal(ui.writes.length, 0);
  assert.throws(() => priorRoot.lookupType('demo.Candidate'));
  assert.ok(priorRoot.lookupType('demo.Existing'));
});

test('valid multi-schema import persists and activates the fully resolved candidate', async () => {
  const initialFiles = [{
    name: 'model.proto',
    content: 'syntax = "proto3"; package demo; message Old { string value = 1; }'
  }];
  const ui = protobufImportContext(initialFiles);
  const priorRoot = liveRoot(ui.context);
  const replacement = 'syntax = "proto3"; package demo; message Current { string value = 1; }';
  const extension = 'syntax = "proto3"; package demo; message Envelope { Current item = 1; }';

  ui.context.importProtobufSchemas();
  await ui.input().onchange({
    target: {
      files: [
        schemaFile('model.proto', replacement),
        schemaFile('envelope.proto', extension)
      ]
    }
  });

  const expectedFiles = [
    { name: 'model.proto', content: replacement },
    { name: 'envelope.proto', content: extension }
  ];
  const nextRoot = liveRoot(ui.context);
  assert.notStrictEqual(nextRoot, priorRoot);
  assert.deepEqual(liveFiles(ui.context), expectedFiles);
  assert.equal(ui.durable.get(storageKey), JSON.stringify(expectedFiles));
  assert.deepEqual(ui.writes, [[storageKey, JSON.stringify(expectedFiles)]]);
  assert.ok(nextRoot.lookupType('demo.Current'));
  assert.ok(nextRoot.lookupType('demo.Envelope'));
  assert.throws(() => nextRoot.lookupType('demo.Old'));
  assert.equal(vm.runInContext('protobufSchemaError', ui.context), '');
  assert.deepEqual(ui.toasts, [{
    message: 'Imported 2 protobuf schema files',
    type: 'success'
  }]);
});

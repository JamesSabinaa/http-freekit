import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helpersStart = source.indexOf('function cloneSendFormFields(');
const helpersEnd = source.indexOf('function loadSendTabState(', helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'Send persistence helpers must exist');
const helpers = source.slice(helpersStart, helpersEnd);

const WORKSPACE_KEY = 'http-freekit-send-workspace-v2';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    json: key => JSON.parse(values.get(key))
  };
}

function createHeldLock() {
  let held;
  return {
    manager: {
      request(_name, callback) {
        return new Promise((resolve, reject) => {
          held = () => Promise.resolve().then(callback).then(resolve, reject);
        });
      }
    },
    get requested() { return typeof held === 'function'; },
    release() {
      assert.equal(typeof held, 'function', 'storage lock was not requested');
      const run = held;
      held = null;
      return run();
    }
  };
}

function createHarness({ storage, locks, tabs }) {
  const elements = {
    sendMethod: { value: 'GET' },
    sendUrl: { value: '' },
    sendBodyFormat: { value: 'text' }
  };
  let body = '';
  let bodyType = 'raw';
  const context = {
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    navigator: { locks },
    document: { getElementById: id => elements[id] || null },
    getSendBodyValue: () => body,
    getSendBodyType: () => bodyType,
    safeLocalStorageGet: (key, fallback = null) => storage.getItem(key) ?? fallback,
    safeLocalStorageSet: (key, value) => {
      storage.setItem(key, value);
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = globalThis.__tabs;
    let activeSendTab = 'tab-1';
    let sendTabCounter = 2;
    let sendHeadersList = [];
    let sendUrlEncodedFields = [];
    let sendMultipartFields = [];
    let sendMultipartBoundary = '';
    ${helpers}
    globalThis.sendPersistenceApi = {
      save: saveSendTabState,
      persist: persistSendTabs,
      unload: persistActiveSendTabBeforeUnload,
      settled: () => sendTabPersistenceQueue,
      setHeaders: value => { sendHeadersList = value; },
      setForms: (urlEncoded, multipart, boundary) => {
        sendUrlEncodedFields = urlEncoded;
        sendMultipartFields = multipart;
        sendMultipartBoundary = boundary;
      }
    };
  `, Object.assign(context, { __tabs: tabs }));

  return {
    api: context.sendPersistenceApi,
    elements,
    setBody(value, type = 'raw') {
      body = value;
      bodyType = type;
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('beforeunload persists unsent active Send edits without losing remote tabs', () => {
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [
        { id: 'tab-1', method: 'GET', url: 'https://old.test' },
        { id: 'tab-2', method: 'GET', url: 'https://remote.test' }
      ],
      deletedTabIds: []
    })
  });
  const harness = createHarness({
    storage,
    locks: null,
    tabs: [
      { id: 'tab-1', method: 'GET', url: '', headers: [], body: '' },
      { id: 'tab-2', method: 'GET', url: 'https://remote.test', headers: [], body: '' }
    ]
  });
  harness.elements.sendMethod.value = 'PATCH';
  harness.elements.sendUrl.value = 'https://edited.test/resource';
  harness.elements.sendBodyFormat.value = 'json';
  harness.setBody('{"saved":true}');
  harness.api.setHeaders([{ key: 'X-Draft', value: 'yes', enabled: true }]);

  harness.api.unload();

  const workspace = storage.json(WORKSPACE_KEY);
  assert.equal(workspace.tabs.length, 2);
  assert.equal(workspace.tabs.find(tab => tab.id === 'tab-1').method, 'PATCH');
  assert.equal(workspace.tabs.find(tab => tab.id === 'tab-1').url, 'https://edited.test/resource');
  assert.equal(workspace.tabs.find(tab => tab.id === 'tab-1').body, '{"saved":true}');
  assert.deepEqual(workspace.tabs.find(tab => tab.id === 'tab-1').headers, [
    { key: 'X-Draft', value: 'yes', enabled: true }
  ]);
  assert.equal(workspace.tabs.find(tab => tab.id === 'tab-2').url, 'https://remote.test');
});

test('a delayed queued save cannot overwrite the final unload snapshot', async () => {
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [{ id: 'tab-1', method: 'GET', url: 'https://initial.test' }],
      deletedTabIds: []
    })
  });
  const heldLock = createHeldLock();
  const harness = createHarness({
    storage,
    locks: heldLock.manager,
    tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }]
  });

  harness.elements.sendUrl.value = 'https://queued-old.test';
  harness.api.save();
  await waitFor(() => heldLock.requested);

  harness.elements.sendMethod.value = 'POST';
  harness.elements.sendUrl.value = 'https://final.test';
  harness.setBody('final body');
  harness.api.unload();
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].url, 'https://final.test');

  await heldLock.release();
  await harness.api.settled();
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].url, 'https://final.test');
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].body, 'final body');
});

test('beforeunload includes queued deletion tombstones', async () => {
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [
        { id: 'tab-1', method: 'GET', url: '' },
        { id: 'tab-2', method: 'GET', url: 'https://deleted.test' }
      ],
      deletedTabIds: []
    })
  });
  const heldLock = createHeldLock();
  const harness = createHarness({
    storage,
    locks: heldLock.manager,
    tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }]
  });

  harness.api.persist([], ['tab-2']);
  await waitFor(() => heldLock.requested);
  harness.api.unload();

  assert.deepEqual(storage.json(WORKSPACE_KEY).tabs.map(tab => tab.id), ['tab-1']);
  assert.deepEqual(storage.json(WORKSPACE_KEY).deletedTabIds, ['tab-2']);
  await heldLock.release();
  await harness.api.settled();
  assert.deepEqual(storage.json(WORKSPACE_KEY).tabs.map(tab => tab.id), ['tab-1']);
});

test('Send persistence registers a synchronous unload handler', () => {
  assert.match(
    source,
    /window\.addEventListener\('beforeunload', persistActiveSendTabBeforeUnload\)/
  );
});

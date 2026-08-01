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
const JOURNAL_PREFIX = 'http-freekit-send-journal-v1:';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  let failJournalWrites = false;
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (failJournalWrites && key.startsWith(JOURNAL_PREFIX)) {
        throw new Error('journal storage unavailable');
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    json(key) {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    journalEntries() {
      return Array.from(values.entries())
        .filter(([key]) => key.startsWith(JOURNAL_PREFIX))
        .map(([key, value]) => ({ key, value: JSON.parse(value) }));
    },
    setFailJournalWrites(value) { failJournalWrites = value; }
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

function createHarness({ storage, locks = null, tabs, active = 'tab-1' }) {
  const elements = {
    sendMethod: { value: 'GET' },
    sendUrl: { value: '' },
    sendBodyFormat: { value: 'text' }
  };
  let body = '';
  let bodyType = 'raw';
  let uuidCounter = 0;
  const context = {
    crypto: {
      randomUUID: () => `11111111-1111-4111-8111-${String(++uuidCounter).padStart(12, '0')}`
    },
    navigator: { locks },
    window: { localStorage: storage },
    document: { getElementById: id => elements[id] || null },
    getSendBodyValue: () => body,
    getSendBodyType: () => bodyType,
    safeLocalStorageGet: (key, fallback = null) => storage.getItem(key) ?? fallback,
    safeLocalStorageSet: (key, value) => {
      try {
        storage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    safeLocalStorageRemove: key => {
      storage.removeItem(key);
      return true;
    },
    loadSendTabState() {},
    renderSendTabs() {}
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = globalThis.__tabs;
    let activeSendTab = globalThis.__active;
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
      restore: restoreSendTabs,
      settled: () => sendTabPersistenceQueue,
      tabs: () => sendTabs,
      setHeaders: value => { sendHeadersList = value; },
      setForms: (urlEncoded, multipart, boundary) => {
        sendUrlEncodedFields = urlEncoded;
        sendMultipartFields = multipart;
        sendMultipartBoundary = boundary;
      }
    };
  `, Object.assign(context, { __tabs: tabs, __active: active }));

  return {
    api: context.sendPersistenceApi,
    elements,
    setBody(value, type = 'raw') {
      body = value;
      bodyType = type;
    }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('beforeunload journals unsent edits without writing the unlocked shared workspace', () => {
  const initialWorkspace = {
    version: 2,
    tabs: [
      { id: 'tab-1', method: 'GET', url: 'https://old.test' },
      { id: 'tab-2', method: 'GET', url: 'https://remote.test' }
    ],
    deletedTabIds: []
  };
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initialWorkspace) });
  const harness = createHarness({
    storage,
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

  assert.equal(harness.api.unload(), true);

  assert.deepEqual(storage.json(WORKSPACE_KEY), initialWorkspace);
  const journals = storage.journalEntries();
  assert.equal(journals.length, 1);
  assert.equal(journals[0].value.deleted, false);
  assert.equal(journals[0].value.tab.method, 'PATCH');
  assert.equal(journals[0].value.tab.url, 'https://edited.test/resource');
  assert.equal(journals[0].value.tab.body, '{"saved":true}');
  assert.deepEqual(journals[0].value.tab.headers, [
    { key: 'X-Draft', value: 'yes', enabled: true }
  ]);
});

test('a delayed queued save commits the newer unload journal instead of overwriting it', async () => {
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
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].url, 'https://initial.test');
  assert.equal(storage.journalEntries().length, 2);

  await heldLock.release();
  await harness.api.settled();
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].url, 'https://final.test');
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].body, 'final body');
  assert.equal(storage.journalEntries().length, 0);
});

test('replay preserves concurrent remote tabs and uses the latest canceled-unload snapshot', async () => {
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [{ id: 'tab-1', method: 'GET', url: 'https://initial.test' }],
      deletedTabIds: []
    })
  });
  const first = createHarness({
    storage,
    tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }]
  });

  first.elements.sendUrl.value = 'https://first-unload.test';
  first.api.unload();
  first.elements.sendUrl.value = 'https://second-unload.test';
  first.api.unload();

  storage.setItem(WORKSPACE_KEY, JSON.stringify({
    version: 2,
    tabs: [
      { id: 'tab-1', method: 'GET', url: 'https://initial.test' },
      { id: 'tab-2', method: 'POST', url: 'https://remote.test' }
    ],
    deletedTabIds: []
  }));

  const restarted = createHarness({
    storage,
    tabs: [{ id: 'tab-99', method: 'GET', url: '', headers: [], body: '' }],
    active: 'tab-99'
  });
  restarted.api.restore();
  assert.deepEqual(plain(restarted.api.tabs()).map(tab => tab.url), [
    'https://second-unload.test', 'https://remote.test'
  ]);
  await restarted.api.settled();

  const workspace = storage.json(WORKSPACE_KEY);
  assert.deepEqual(workspace.tabs.map(tab => tab.url), [
    'https://second-unload.test', 'https://remote.test'
  ]);
  assert.equal(storage.journalEntries().length, 0);
});

test('journal replay preserves a queued deletion tombstone across process exit', async () => {
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
  const exiting = createHarness({
    storage,
    locks: heldLock.manager,
    tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }]
  });

  exiting.api.persist([], ['tab-2']);
  await waitFor(() => heldLock.requested);
  assert.equal(storage.json(WORKSPACE_KEY).deletedTabIds.length, 0);
  assert.equal(storage.journalEntries().some(entry => entry.value.deleted), true);

  const restarted = createHarness({
    storage,
    tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }]
  });
  restarted.api.restore();
  assert.deepEqual(plain(restarted.api.tabs()).map(tab => tab.id), ['tab-1']);
  await restarted.api.settled();

  assert.deepEqual(storage.json(WORKSPACE_KEY).tabs.map(tab => tab.id), ['tab-1']);
  assert.deepEqual(storage.json(WORKSPACE_KEY).deletedTabIds, ['tab-2']);
  assert.equal(storage.journalEntries().length, 0);
});

test('beforeunload blocks navigation when the final journal cannot be stored', () => {
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify({ version: 2, tabs: [], deletedTabIds: [] })
  });
  storage.setFailJournalWrites(true);
  const harness = createHarness({
    storage,
    tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }]
  });
  harness.elements.sendUrl.value = 'https://must-not-be-lost.test';
  let prevented = false;
  const event = {
    returnValue: undefined,
    preventDefault() { prevented = true; }
  };

  assert.equal(harness.api.unload(event), false);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  assert.equal(storage.journalEntries().length, 0);
});

test('Send header text fields update the captured model before blur', () => {
  const renderStart = source.indexOf('function renderSendHeaders()');
  const renderEnd = source.indexOf('function addSendHeader(', renderStart);
  const renderer = source.slice(renderStart, renderEnd);
  assert.match(renderer, /oninput="updateSendHeaderKey\(\$\{i\}, this\.value\)"/);
  assert.match(renderer, /oninput="updateSendHeaderVal\(\$\{i\}, this\.value\)"/);
  assert.doesNotMatch(renderer, /onchange="updateSendHeader(?:Key|Val)/);
});

test('Send persistence registers a synchronous unload handler', () => {
  assert.match(
    source,
    /window\.addEventListener\('beforeunload', persistActiveSendTabBeforeUnload\)/
  );
  assert.match(
    source,
    /window\.prepareSendTabPersistenceForQuit = persistActiveSendTabBeforeUnload/
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helpersStart = source.indexOf('function cloneSendFormFields');
const helpersEnd = source.indexOf('function loadSendTabState', helpersStart);
assert.notEqual(helpersStart, -1);
assert.notEqual(helpersEnd, -1);
const helpers = source.slice(helpersStart, helpersEnd);

const WORKSPACE_KEY = 'http-freekit-send-workspace-v2';
const LEGACY_KEY = 'http-freekit-send-tabs';

function createLockManager() {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  return {
    async request(_name, callback) {
      requests++;
      const run = tail.then(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        try {
          return callback();
        } finally {
          active--;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
    get maxActive() { return maxActive; },
    get requests() { return requests; }
  };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    json(key) {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value);
    }
  };
}

function createRenderer(storage, locks, uuid) {
  const context = {
    crypto: { randomUUID: () => typeof uuid === 'function' ? uuid() : uuid },
    navigator: { locks },
    safeLocalStorageGet: (key, fallback = null) => storage.getItem(key) ?? fallback,
    safeLocalStorageSet: (key, value) => {
      storage.setItem(key, value);
      return true;
    },
    loadSendTabState() {},
    renderSendTabs() {}
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }];
    let activeSendTab = 'tab-1';
    let sendTabCounter = 1;
    ${helpers}
    this.sendTabTestApi = {
      restore: restoreSendTabs,
      create: createEmptySendTab,
      persist: persistSendTabs,
      merge: mergeStoredSendWorkspace,
      handleStorage: handleSendTabStorageEvent,
      setTabs(tabs, active) { sendTabs = tabs; activeSendTab = active; },
      tabs() { return sendTabs; },
      active() { return activeSendTab; }
    };
  `, context);
  return context.sendTabTestApi;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const firstUuid = '11111111-1111-4111-8111-111111111111';
const secondUuid = '22222222-2222-4222-8222-222222222222';

test('new tabs skip identities already reserved by remote tombstones', () => {
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [{ id: 'tab-1', method: 'GET', url: '' }],
      deletedTabIds: [`tab-${firstUuid}`]
    })
  });
  const candidates = [firstUuid, secondUuid];
  const renderer = createRenderer(storage, createLockManager(), () => candidates.shift());
  renderer.restore();

  assert.equal(renderer.create().id, `tab-${secondUuid}`);
  assert.deepEqual(candidates, []);
});

test('sequential stale-window writes merge tab changes instead of replacing the workspace', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://legacy.test' }])
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, firstUuid);
  const second = createRenderer(storage, locks, secondUuid);
  first.restore();
  second.restore();

  const firstTab = first.create();
  firstTab.url = 'https://first.test';
  first.setTabs([...plain(first.tabs()), firstTab], firstTab.id);
  await first.persist([firstTab]);

  const secondTab = second.create();
  secondTab.url = 'https://second.test';
  second.setTabs([...plain(second.tabs()), secondTab], secondTab.id);
  await second.persist([secondTab]);

  const workspace = storage.json(WORKSPACE_KEY);
  assert.deepEqual(workspace.tabs.map(tab => tab.url), [
    'https://legacy.test', 'https://first.test', 'https://second.test'
  ]);
  assert.deepEqual(workspace.deletedTabIds, []);
});

test('overlapping creates are serialized and receive collision-proof IDs', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: '' }])
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, firstUuid);
  const second = createRenderer(storage, locks, secondUuid);
  first.restore();
  second.restore();
  const firstTab = first.create();
  const secondTab = second.create();

  assert.equal(firstTab.id, `tab-${firstUuid}`);
  assert.equal(secondTab.id, `tab-${secondUuid}`);
  assert.notEqual(firstTab.id, secondTab.id);

  const firstWrite = first.persist([{ ...firstTab, body: 'first' }]);
  const secondWrite = second.persist([{ ...secondTab, body: 'second' }]);
  await Promise.all([firstWrite, secondWrite]);

  const workspace = storage.json(WORKSPACE_KEY);
  assert.equal(new Set(workspace.tabs.map(tab => tab.id)).size, 3);
  assert.deepEqual(workspace.tabs.map(tab => tab.body), ['', 'first', 'second']);
  assert.equal(locks.requests, 2);
  assert.equal(locks.maxActive, 1);
});

test('a deletion tombstone defeats overlapping and later stale updates', async () => {
  const initialWorkspace = {
    version: 2,
    tabs: [
      { id: 'tab-1', method: 'GET', url: 'https://keep.test' },
      { id: 'tab-2', method: 'POST', url: 'https://close.test' }
    ],
    deletedTabIds: []
  };
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initialWorkspace) });
  const locks = createLockManager();
  const closer = createRenderer(storage, locks, firstUuid);
  const stale = createRenderer(storage, locks, secondUuid);
  closer.restore();
  stale.restore();
  stale.setTabs(plain(stale.tabs()), 'tab-2');
  const staleClosedTab = plain(stale.tabs().find(tab => tab.id === 'tab-2'));
  staleClosedTab.body = 'stale update';

  const closeWrite = closer.persist([], ['tab-2']);
  const overlappingStaleWrite = stale.persist([staleClosedTab]);
  await Promise.all([closeWrite, overlappingStaleWrite]);
  await stale.persist([{ ...staleClosedTab, body: 'even later stale update' }]);

  const workspace = storage.json(WORKSPACE_KEY);
  assert.deepEqual(workspace.tabs.map(tab => tab.id), ['tab-1']);
  assert.deepEqual(workspace.deletedTabIds, ['tab-2']);

  stale.handleStorage({ key: WORKSPACE_KEY, newValue: JSON.stringify(workspace) });
  assert.deepEqual(plain(stale.tabs()).map(tab => tab.id), ['tab-1']);
  assert.equal(stale.active(), 'tab-1');
});

test('legacy tabs migrate on first write without persisting file objects or responses', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{
      id: 'tab-7',
      method: 'POST',
      url: 'https://upload.test',
      bodyType: 'multipart',
      multipartFields: [{ key: 'upload', type: 'file', fileName: 'saved.txt' }]
    }])
  });
  const renderer = createRenderer(storage, createLockManager(), firstUuid);
  renderer.restore();
  const restored = plain(renderer.tabs());
  assert.equal(restored[0].id, 'tab-7');
  assert.equal(restored[0].multipartFields[0].fileName, 'saved.txt');

  const file = { name: 'local.bin', type: 'application/octet-stream', bytes: 'secret' };
  const liveTab = renderer.tabs()[0];
  liveTab.multipartFields = [{ key: 'upload', type: 'file', file }];
  liveTab.response = { statusCode: 200, body: 'transient response' };
  await renderer.persist([liveTab]);

  const workspace = storage.json(WORKSPACE_KEY);
  assert.equal(workspace.version, 2);
  assert.equal(workspace.tabs[0].id, 'tab-7');
  assert.equal(workspace.tabs[0].multipartFields[0].fileName, 'local.bin');
  assert.equal('file' in workspace.tabs[0].multipartFields[0], false);
  assert.equal('response' in workspace.tabs[0], false);
});

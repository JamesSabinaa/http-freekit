import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const corruptionStart = source.indexOf('const rendererStorageCorruptions = new Map();');
const corruptionEnd = source.indexOf('function capturedConnectionHeaderNames(', corruptionStart);
const helpersStart = source.indexOf('function cloneSendFormFields');
const helpersEnd = source.indexOf('function inferCurlSendBodyFormat', helpersStart);
const switchStart = source.indexOf('function switchSendTab(', helpersEnd);
const switchEnd = source.indexOf('function addSendTab(', switchStart);
assert.ok(corruptionStart >= 0 && corruptionEnd > corruptionStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
assert.ok(switchStart >= 0 && switchEnd > switchStart);
const helpers = source.slice(helpersStart, helpersEnd);
const switchHelper = source.slice(switchStart, switchEnd);
const corruptionHelpers = source.slice(corruptionStart, corruptionEnd);

const WORKSPACE_KEY = 'http-freekit-send-workspace-v3';
const V2_WORKSPACE_KEY = 'http-freekit-send-workspace-v2';
const JOURNAL_PREFIX = 'http-freekit-send-journal-v2:';
const LEGACY_KEY = 'http-freekit-send-tabs';

function createLockManager() {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  return {
    async request(_name, callback) {
      const run = tail.then(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        try { return callback(); } finally { active--; }
      });
      tail = run.catch(() => {});
      return run;
    },
    get maxActive() { return maxActive; }
  };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    json(key) {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    keys() { return Array.from(values.keys()); }
  };
}

function createRenderer(storage, locks, uuidPrefix) {
  let uuidCounter = 0;
  let body = '';
  let bodyType = 'raw';
  const toasts = [];
  const elements = {
    sendMethod: { value: 'GET', setCustomValidity() {}, setAttribute() {}, focus() {} },
    sendUrl: { value: '' },
    sendBodyFormat: { value: 'text' }
  };
  const context = {
    __tabs: [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }],
    __active: 'tab-1',
    __toasts: toasts,
    crypto: {
      randomUUID: () => `${uuidPrefix}-1111-4111-8111-${String(++uuidCounter).padStart(12, '0')}`
    },
    navigator: { locks },
    window: { localStorage: storage },
    document: { getElementById: id => elements[id] || null },
    safeLocalStorageGet: (key, fallback = null) => storage.getItem(key) ?? fallback,
    safeLocalStorageSet: (key, value) => {
      storage.setItem(key, value);
      return true;
    },
    safeLocalStorageRemove: key => {
      storage.removeItem(key);
      return true;
    },
    getSendBodyValue: () => body,
    getSendBodyType: () => bodyType,
    setSendBodyValue: value => { body = value; },
    renderSendHeaders() {},
    renderSendTabs() {},
    updateSendBodyLanguage() {},
    updateSendBodyType() {},
    updateSendMethodColor() {},
    disposeBodyEditor() {},
    setSendLoading() {},
    standaloneBodyViewers: {},
    sendAbortControllers: new Map(),
    toast(message, type) { toasts.push({ message, type }); }
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = globalThis.__tabs;
    let activeSendTab = globalThis.__active;
    let sendTabCounter = 1;
    let sendHeadersList = [];
    let sendUrlEncodedFields = [];
    let sendMultipartFields = [];
    let sendMultipartBoundary = '';
    ${corruptionHelpers}
    ${helpers}
    ${switchHelper}
    globalThis.sendTabTestApi = {
      restore: restoreSendTabs,
      persist: persistSendTabs,
      settled: () => sendTabPersistenceQueue,
      create: createEmptySendTab,
      handleStorage: handleSendTabStorageEvent,
      load(id = activeSendTab) {
        activeSendTab = id;
        return loadSendTabState(sendTabs.find(tab => tab.id === id));
      },
      setTabs(tabs, active) { sendTabs = tabs; activeSendTab = active; },
      switch: switchSendTab,
      tabs: () => sendTabs,
      active: () => activeSendTab,
      pending: () => pendingSendTabJournals.size,
      setMultipartFields(fields) { sendMultipartFields = fields; },
      toasts: () => globalThis.__toasts
    };
  `, context);
  return {
    api: context.sendTabTestApi,
    elements,
    setEditor({ method, url, nextBody, nextBodyType } = {}) {
      if (method !== undefined) elements.sendMethod.value = method;
      if (url !== undefined) elements.sendUrl.value = url;
      if (nextBody !== undefined) body = nextBody;
      if (nextBodyType !== undefined) bodyType = nextBodyType;
    },
    editor() { return { method: elements.sendMethod.value, url: elements.sendUrl.value, body }; }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function storedTabs(storage) {
  return storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab);
}

async function restore(renderer) {
  renderer.api.restore();
  await renderer.api.settled();
  renderer.api.load();
}

test('legacy tabs migrate once to the isolated v3 workspace', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-7', method: 'POST', url: 'https://legacy.test' }])
  });
  const renderer = createRenderer(storage, createLockManager(), '11111111');
  await restore(renderer);

  const workspace = storage.json(WORKSPACE_KEY);
  assert.equal(workspace.version, 3);
  assert.equal(workspace.tabs[0].tab.id, 'tab-7');
  assert.equal(workspace.tabs[0].tab.url, 'https://legacy.test');
  assert.equal(storage.getItem(LEGACY_KEY), null);
  assert.equal(workspace.retiredJournalTokens, undefined);

  storage.setItem(LEGACY_KEY, JSON.stringify([
    { id: 'tab-7', method: 'GET', url: 'https://stale-old-window.test' }
  ]));
  renderer.api.restore();
  await renderer.api.settled();
  assert.equal(storedTabs(storage)[0].url, 'https://legacy.test');
});

test('separate stale windows merge collision-proof tab creates under one lock', async () => {
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [{ id: 'tab-1', method: 'GET', url: 'https://initial.test' }],
      deletedTabIds: []
    })
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, '11111111');
  const second = createRenderer(storage, locks, '22222222');
  await Promise.all([restore(first), restore(second)]);

  const firstTab = first.api.create();
  firstTab.url = 'https://first.test';
  first.api.setTabs([...plain(first.api.tabs()), firstTab], firstTab.id);
  const secondTab = second.api.create();
  secondTab.url = 'https://second.test';
  second.api.setTabs([...plain(second.api.tabs()), secondTab], secondTab.id);
  await Promise.all([first.api.persist([firstTab]), second.api.persist([secondTab])]);

  assert.deepEqual(storedTabs(storage).map(tab => tab.url).sort(), [
    'https://first.test', 'https://initial.test', 'https://second.test'
  ]);
  assert.equal(new Set(storedTabs(storage).map(tab => tab.id)).size, 3);
  assert.equal(locks.maxActive, 1);
});

test('a clean active editor reloads a same-tab remote revision and cannot revert it', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://old.test' }])
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, '11111111');
  const second = createRenderer(storage, locks, '22222222');
  await restore(first);
  await restore(second);

  await second.api.persist([{ ...plain(second.api.tabs()[0]), url: 'https://remote.test' }]);
  first.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });

  assert.equal(first.editor().url, 'https://remote.test');
  await first.api.persist(first.api.tabs());
  assert.equal(storedTabs(storage)[0].url, 'https://remote.test');
});

test('a dirty active editor forks on a same-tab remote update', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://old.test' }])
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, '11111111');
  const second = createRenderer(storage, locks, '22222222');
  await restore(first);
  await restore(second);

  first.setEditor({ url: 'https://local-draft.test' });
  await second.api.persist([{ ...plain(second.api.tabs()[0]), url: 'https://remote.test' }]);
  first.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await first.api.settled();

  assert.deepEqual(storedTabs(storage).map(tab => tab.url).sort(), [
    'https://local-draft.test', 'https://remote.test'
  ]);
  assert.notEqual(first.api.active(), 'tab-1');
  assert.match(first.api.toasts().at(-1).message, /draft was preserved/i);
});

test('a dirty active editor also forks when the remote tab was deleted', async () => {
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [
        { id: 'tab-1', method: 'GET', url: 'https://keep.test' },
        { id: 'tab-2', method: 'POST', url: 'https://draft-base.test' }
      ],
      deletedTabIds: []
    })
  });
  const locks = createLockManager();
  const dirty = createRenderer(storage, locks, '11111111');
  const closer = createRenderer(storage, locks, '22222222');
  await restore(dirty);
  await restore(closer);
  dirty.api.load('tab-2');
  dirty.setEditor({ url: 'https://local-after-delete.test' });

  await closer.api.persist([], ['tab-2']);
  dirty.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await dirty.api.settled();

  const tabs = storedTabs(storage);
  assert.equal(tabs.some(tab => tab.id === 'tab-2'), false);
  assert.equal(tabs.some(tab => tab.url === 'https://local-after-delete.test'), true);
});

test('a same-metadata multipart file survives a remote tab deletion in a fork', async () => {
  const rememberedFile = {
    key: 'upload',
    value: '',
    enabled: true,
    type: 'file',
    fileName: 'same.bin',
    fileType: 'application/octet-stream'
  };
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [
        { id: 'tab-1', method: 'GET', url: 'https://keep.test' },
        {
          id: 'tab-2',
          method: 'POST',
          url: 'https://upload.test',
          bodyType: 'multipart',
          multipartFields: [rememberedFile]
        }
      ],
      deletedTabIds: []
    })
  });
  const locks = createLockManager();
  const dirty = createRenderer(storage, locks, '11111111');
  const closer = createRenderer(storage, locks, '22222222');
  await restore(dirty);
  await restore(closer);
  dirty.api.load('tab-2');
  const selectedFile = {
    name: rememberedFile.fileName,
    type: rememberedFile.fileType,
    size: 42,
    lastModified: 1234
  };
  dirty.api.setMultipartFields([{ ...rememberedFile, file: selectedFile }]);

  await closer.api.persist([], ['tab-2']);
  dirty.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await dirty.api.settled();

  const fork = dirty.api.tabs().find(tab => tab.id === dirty.api.active());
  assert.notEqual(fork.id, 'tab-2');
  assert.equal(fork.multipartFields[0].file, selectedFile);
  assert.equal(storedTabs(storage).some(tab =>
    tab.id === fork.id && tab.multipartFields[0].fileName === 'same.bin'
  ), true);
});

test('a same-metadata multipart file survives a new-generation replacement in a fork', async () => {
  const rememberedFile = {
    key: 'upload',
    value: '',
    enabled: true,
    type: 'file',
    fileName: 'same.bin',
    fileType: 'application/octet-stream'
  };
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [{
        id: 'tab-1',
        method: 'POST',
        url: 'https://upload.test',
        bodyType: 'multipart',
        multipartFields: [rememberedFile]
      }],
      deletedTabIds: []
    })
  });
  const renderer = createRenderer(storage, createLockManager(), '11111111');
  await restore(renderer);
  const selectedFile = {
    name: rememberedFile.fileName,
    type: rememberedFile.fileType,
    size: 42,
    lastModified: 1234
  };
  renderer.api.setMultipartFields([{ ...rememberedFile, file: selectedFile }]);

  const replacement = storage.json(WORKSPACE_KEY);
  replacement.tabs[0].generation = 'generation-remote-replacement';
  replacement.tabs[0].revision = 'revision-remote-replacement';
  storage.setItem(WORKSPACE_KEY, JSON.stringify(replacement));
  renderer.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await renderer.api.settled();

  const fork = renderer.api.tabs().find(tab => tab.id === renderer.api.active());
  assert.notEqual(fork.id, 'tab-1');
  assert.equal(fork.multipartFields[0].file, selectedFile);
  assert.equal(storedTabs(storage).some(tab => tab.id === 'tab-1'), true);
  assert.equal(storedTabs(storage).some(tab => tab.id === fork.id), true);
});

async function rendererWithInactiveSelectedFile(storage, locks, uuidPrefix) {
  const renderer = createRenderer(storage, locks, uuidPrefix);
  await restore(renderer);
  renderer.api.load('tab-2');
  const selectedFile = {
    name: 'same.bin',
    type: 'application/octet-stream',
    size: 42,
    lastModified: 1234
  };
  renderer.api.setMultipartFields([{
    key: 'upload', value: '', enabled: true, type: 'file',
    fileName: selectedFile.name, fileType: selectedFile.type, file: selectedFile
  }]);
  renderer.api.switch('tab-1');
  await renderer.api.settled();
  return { renderer, selectedFile };
}

function twoTabFileWorkspace() {
  return {
    version: 2,
    tabs: [
      { id: 'tab-1', method: 'GET', url: 'https://active.test' },
      {
        id: 'tab-2', method: 'POST', url: 'https://upload.test', bodyType: 'multipart',
        multipartFields: [{
          key: 'upload', value: '', enabled: true, type: 'file',
          fileName: 'same.bin', fileType: 'application/octet-stream'
        }]
      }
    ],
    deletedTabIds: []
  };
}

test('an inactive selected file survives a remote tab deletion in a fork', async () => {
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify(twoTabFileWorkspace())
  });
  const locks = createLockManager();
  const { renderer, selectedFile } = await rendererWithInactiveSelectedFile(
    storage, locks, '11111111'
  );
  const closer = createRenderer(storage, locks, '22222222');
  await restore(closer);

  await closer.api.persist([], ['tab-2']);
  renderer.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await renderer.api.settled();

  const preserved = renderer.api.tabs().find(tab => tab.multipartFields?.[0]?.file === selectedFile);
  assert.ok(preserved);
  assert.notEqual(preserved.id, 'tab-2');
  assert.equal(renderer.api.active(), 'tab-1');
  assert.equal(storedTabs(storage).some(tab => tab.id === preserved.id), true);
});

test('an inactive selected file survives a new-generation replacement in a fork', async () => {
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify(twoTabFileWorkspace())
  });
  const { renderer, selectedFile } = await rendererWithInactiveSelectedFile(
    storage, createLockManager(), '11111111'
  );
  const replacement = storage.json(WORKSPACE_KEY);
  const remoteTab = replacement.tabs.find(entry => entry.tab.id === 'tab-2');
  remoteTab.generation = 'generation-remote-replacement';
  remoteTab.revision = 'revision-remote-replacement';
  storage.setItem(WORKSPACE_KEY, JSON.stringify(replacement));

  renderer.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await renderer.api.settled();

  const preserved = renderer.api.tabs().find(tab => tab.multipartFields?.[0]?.file === selectedFile);
  assert.ok(preserved);
  assert.notEqual(preserved.id, 'tab-2');
  assert.equal(renderer.api.active(), 'tab-1');
  assert.equal(storedTabs(storage).some(tab => tab.id === 'tab-2'), true);
  assert.equal(storedTabs(storage).some(tab => tab.id === preserved.id), true);
});

test('an inactive selected file forks instead of merging into a changed remote revision', async () => {
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify(twoTabFileWorkspace())
  });
  const { renderer, selectedFile } = await rendererWithInactiveSelectedFile(
    storage, createLockManager(), '11111111'
  );
  const changed = storage.json(WORKSPACE_KEY);
  const remoteTab = changed.tabs.find(entry => entry.tab.id === 'tab-2');
  remoteTab.tab.url = 'https://remote-change.test';
  remoteTab.revision = 'revision-remote-change';
  storage.setItem(WORKSPACE_KEY, JSON.stringify(changed));

  renderer.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await renderer.api.settled();

  const original = renderer.api.tabs().find(tab => tab.id === 'tab-2');
  const preserved = renderer.api.tabs().find(tab => tab.multipartFields?.[0]?.file === selectedFile);
  assert.equal(original.url, 'https://remote-change.test');
  assert.equal(original.multipartFields[0].file, undefined);
  assert.ok(preserved);
  assert.notEqual(preserved.id, 'tab-2');
  assert.equal(preserved.url, 'https://upload.test');
  assert.equal(storedTabs(storage).some(tab =>
    tab.id === preserved.id && tab.url === 'https://upload.test'
  ), true);
});

test('a missed storage event is still protected by revision CAS', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://old.test' }])
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, '11111111');
  const stale = createRenderer(storage, locks, '22222222');
  await restore(first);
  await restore(stale);

  await first.api.persist([{ ...plain(first.api.tabs()[0]), url: 'https://winner.test' }]);
  await stale.api.persist([{ ...plain(stale.api.tabs()[0]), url: 'https://stale-draft.test' }]);

  assert.deepEqual(storedTabs(storage).map(tab => tab.url).sort(), [
    'https://stale-draft.test', 'https://winner.test'
  ]);
  assert.match(stale.api.toasts().at(-1).message, /draft was preserved/i);
});

test('a pending local journal survives an intervening storage event with one fork', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://old.test' }])
  });
  const locks = createLockManager();
  const renderer = createRenderer(storage, locks, '11111111');
  await restore(renderer);
  renderer.setEditor({ url: 'https://pending-draft.test' });
  const pending = renderer.api.persist([
    { ...plain(renderer.api.tabs()[0]), url: 'https://pending-draft.test' }
  ]);
  const current = storage.json(WORKSPACE_KEY);
  current.tabs[0].tab.url = 'https://intervening-remote.test';
  current.tabs[0].revision = 'revision-intervening-remote';
  storage.setItem(WORKSPACE_KEY, JSON.stringify(current));
  renderer.api.handleStorage({ key: WORKSPACE_KEY, newValue: storage.getItem(WORKSPACE_KEY) });
  await pending;
  await renderer.api.settled();

  assert.deepEqual(storedTabs(storage).map(tab => tab.url).sort(), [
    'https://intervening-remote.test', 'https://pending-draft.test'
  ]);
  assert.equal(storedTabs(storage).length, 2);
});

test('identical concurrent updates acknowledge without creating a fork', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://old.test' }])
  });
  const locks = createLockManager();
  const first = createRenderer(storage, locks, '11111111');
  const second = createRenderer(storage, locks, '22222222');
  await restore(first);
  await restore(second);
  const update = tab => ({ ...plain(tab), url: 'https://same.test' });

  await first.api.persist([update(first.api.tabs()[0])]);
  await second.api.persist([update(second.api.tabs()[0])]);

  assert.equal(storedTabs(storage).length, 1);
  assert.equal(storedTabs(storage)[0].url, 'https://same.test');
});

test('delete and stale-update races never resurrect or overwrite the original identity', async () => {
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [
        { id: 'tab-1', method: 'GET', url: 'https://keep.test' },
        { id: 'tab-2', method: 'POST', url: 'https://delete.test' }
      ],
      deletedTabIds: []
    })
  });
  const locks = createLockManager();
  const closer = createRenderer(storage, locks, '11111111');
  const stale = createRenderer(storage, locks, '22222222');
  await restore(closer);
  await restore(stale);
  const staleTab = { ...plain(stale.api.tabs().find(tab => tab.id === 'tab-2')), body: 'draft' };

  await closer.api.persist([], ['tab-2']);
  await stale.api.persist([staleTab]);

  const tabs = storedTabs(storage);
  assert.equal(tabs.some(tab => tab.id === 'tab-2'), false);
  assert.equal(tabs.some(tab => tab.body === 'draft'), true);
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens, undefined);
});

test('a stale delete cannot remove a newer revision', async () => {
  const storage = createStorage({
    [LEGACY_KEY]: JSON.stringify([{ id: 'tab-1', method: 'GET', url: 'https://old.test' }])
  });
  const locks = createLockManager();
  const updater = createRenderer(storage, locks, '11111111');
  const staleCloser = createRenderer(storage, locks, '22222222');
  await restore(updater);
  await restore(staleCloser);

  await updater.api.persist([{ ...plain(updater.api.tabs()[0]), url: 'https://new.test' }]);
  await staleCloser.api.persist([], ['tab-1']);

  assert.equal(storedTabs(storage)[0].id, 'tab-1');
  assert.equal(storedTabs(storage)[0].url, 'https://new.test');
});

test('healthy create/delete churn leaves no historical tombstones or journals', async () => {
  const storage = createStorage();
  const renderer = createRenderer(storage, createLockManager(), '11111111');
  await restore(renderer);
  for (let index = 0; index < 100; index++) {
    const tab = renderer.api.create();
    tab.url = `https://churn-${index}.test`;
    await renderer.api.persist([tab]);
    await renderer.api.persist([], [tab.id]);
  }

  const workspace = storage.json(WORKSPACE_KEY);
  assert.equal(workspace.retiredJournalTokens, undefined);
  assert.equal(storage.keys().some(key => key.startsWith(JOURNAL_PREFIX)), false);
});

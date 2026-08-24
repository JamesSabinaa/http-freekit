import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const corruptionStart = source.indexOf('const rendererStorageCorruptions = new Map();');
const corruptionEnd = source.indexOf('function capturedConnectionHeaderNames(', corruptionStart);
const helpersStart = source.indexOf('function cloneSendFormFields(');
const helpersEnd = source.indexOf('function inferCurlSendBodyFormat', helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
const helpers = source.slice(helpersStart, helpersEnd);
const corruptionHelpers = source.slice(corruptionStart, corruptionEnd);

const WORKSPACE_KEY = 'http-freekit-send-workspace-v3';
const V2_WORKSPACE_KEY = 'http-freekit-send-workspace-v2';
const JOURNAL_PREFIX = 'http-freekit-send-journal-v2:';
const V1_JOURNAL_PREFIX = 'http-freekit-send-journal-v1:';

function storedTab(id, url, suffix) {
  return {
    tab: { id, method: 'GET', url, headers: [], body: '' },
    generation: `generation-${suffix}`,
    revision: `revision-${suffix}`
  };
}

function workspace(tabs) {
  return { version: 3, tabs };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  let failJournalWrites = false;
  let failJournalRemovals = false;
  let journalRemovalFailuresRemaining = 0;
  let failWorkspaceWrites = false;
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (failWorkspaceWrites && key === WORKSPACE_KEY) {
        throw new Error('workspace storage unavailable');
      }
      if (failJournalWrites && key.startsWith(JOURNAL_PREFIX)) {
        throw new Error('journal storage unavailable');
      }
      values.set(key, String(value));
    },
    removeItem(key) {
      if (key.startsWith(JOURNAL_PREFIX) &&
          (failJournalRemovals || journalRemovalFailuresRemaining > 0)) {
        if (journalRemovalFailuresRemaining > 0) journalRemovalFailuresRemaining--;
        throw new Error('journal cleanup unavailable');
      }
      values.delete(key);
    },
    json(key) {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    journalEntries(prefix = JOURNAL_PREFIX) {
      return Array.from(values.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: JSON.parse(value) }));
    },
    setFailJournalWrites(value) { failJournalWrites = value; },
    setFailJournalRemovals(value) { failJournalRemovals = value; },
    failNextJournalRemovals(count = 1) { journalRemovalFailuresRemaining = count; },
    setFailWorkspaceWrites(value) { failWorkspaceWrites = value; }
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

function createHarness({ storage, locks = null, tabs, active = 'tab-1', uuidPrefix = '11111111' }) {
  const elements = {
    sendMethod: { value: 'GET', setCustomValidity() {}, setAttribute() {}, focus() {} },
    sendUrl: { value: '' },
    sendBodyFormat: { value: 'text' }
  };
  let body = '';
  let bodyType = 'raw';
  let uuidCounter = 0;
  const toasts = [];
  const context = {
    __tabs: tabs,
    __active: active,
    __toasts: toasts,
    crypto: {
      randomUUID: () => `${uuidPrefix}-1111-4111-8111-${String(++uuidCounter).padStart(12, '0')}`
    },
    navigator: { locks },
    window: { localStorage: storage },
    document: { getElementById: id => elements[id] || null },
    getSendBodyValue: () => body,
    getSendBodyType: () => bodyType,
    setSendBodyValue: value => { body = value; },
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
      try {
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
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
    let sendTabCounter = 2;
    let sendHeadersList = [];
    let sendUrlEncodedFields = [];
    let sendMultipartFields = [];
    let sendMultipartBoundary = '';
    ${corruptionHelpers}
    ${helpers}
    globalThis.sendPersistenceApi = {
      save: saveSendTabState,
      persist: persistSendTabs,
      unload: persistActiveSendTabBeforeUnload,
      restore: restoreSendTabs,
      create: createEmptySendTab,
      settled: () => sendTabPersistenceQueue,
      load(id = activeSendTab) {
        activeSendTab = id;
        return loadSendTabState(sendTabs.find(tab => tab.id === id));
      },
      tabs: () => sendTabs,
      pending: () => pendingSendTabJournals.size,
      toasts: () => globalThis.__toasts,
      setHeaders: value => { sendHeadersList = value; },
      stageDelete: id => Boolean(stageSendTabJournal(createSendTabJournal(id, null, true)))
    };
  `, context);

  return {
    api: context.sendPersistenceApi,
    elements,
    setBody(value, type = 'raw') { body = value; bodyType = type; },
    setEditor({ method, url } = {}) {
      if (method !== undefined) elements.sendMethod.value = method;
      if (url !== undefined) elements.sendUrl.value = url;
    }
  };
}

async function restore(harness) {
  harness.api.restore();
  await harness.api.settled();
  harness.api.load();
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('beforeunload journals revision-bound unsent edits without writing the workspace', async () => {
  const initialWorkspace = workspace([
    storedTab('tab-1', 'https://old.test', 'tab-one'),
    storedTab('tab-2', 'https://remote.test', 'tab-two')
  ]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initialWorkspace) });
  const harness = createHarness({
    storage,
    tabs: initialWorkspace.tabs.map(entry => entry.tab)
  });
  await restore(harness);
  harness.setEditor({ method: 'PATCH', url: 'https://edited.test/resource' });
  harness.elements.sendBodyFormat.value = 'json';
  harness.setBody('{"saved":true}');
  harness.api.setHeaders([{ key: 'X-Draft', value: 'yes', enabled: true }]);

  assert.equal(harness.api.unload(), true);
  assert.deepEqual(storage.json(WORKSPACE_KEY), initialWorkspace);
  const journals = storage.journalEntries();
  assert.equal(journals.length, 1);
  assert.equal(journals[0].value.version, 2);
  assert.equal(journals[0].value.operation, 'update');
  assert.equal(journals[0].value.baseRevision, 'revision-tab-one');
  assert.equal(journals[0].value.tab.method, 'PATCH');
  assert.equal(journals[0].value.tab.url, 'https://edited.test/resource');
  assert.equal(journals[0].value.tab.body, '{"saved":true}');
});

test('a delayed save commits the newer unload journal in the same writer chain', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const harness = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  harness.api.restore();
  harness.api.load();

  harness.setEditor({ url: 'https://queued-old.test' });
  harness.api.save();
  await waitFor(() => heldLock.requested);
  harness.setEditor({ method: 'POST', url: 'https://final.test' });
  harness.setBody('final body');
  assert.equal(harness.api.unload(), true);
  assert.equal(storage.journalEntries().length, 2);

  await heldLock.release();
  await harness.api.settled();
  const saved = storage.json(WORKSPACE_KEY).tabs[0].tab;
  assert.equal(saved.url, 'https://final.test');
  assert.equal(saved.body, 'final body');
  assert.equal(storage.journalEntries().length, 0);
});

test('a queued edit follows an identical concurrent revision without forking', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const renderer = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  const identicalSave = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://same.test' }
  ]);
  await waitFor(() => heldLock.requested);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://same.test' },
    generation: initial.tabs[0].generation,
    revision: 'revision-remote-identical'
  }])));
  const queuedSave = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://final.test' }
  ]);

  await heldLock.release();
  await identicalSave;
  await waitFor(() => heldLock.requested);
  await heldLock.release();
  await queuedSave;
  assert.deepEqual(
    storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.url),
    ['https://final.test']
  );
  assert.equal(storage.journalEntries().length, 0);
});

test('a queued delete follows an identical concurrent revision', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const renderer = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  const identicalSave = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://same.test' }
  ]);
  await waitFor(() => heldLock.requested);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://same.test' },
    generation: initial.tabs[0].generation,
    revision: 'revision-remote-identical'
  }])));
  const queuedDelete = renderer.api.persist([], ['tab-1']);

  await heldLock.release();
  await identicalSave;
  await waitFor(() => heldLock.requested);
  await heldLock.release();
  await queuedDelete;
  assert.equal(storage.json(WORKSPACE_KEY).tabs.length, 0);
  assert.equal(storage.journalEntries().length, 0);
});

test('a queued delete follows a stale update into its conflict fork', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const renderer = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  const staleDraft = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://local-draft.test' }
  ]);
  await waitFor(() => heldLock.requested);
  const queuedDelete = renderer.api.persist([], ['tab-1']);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://remote.test' },
    generation: initial.tabs[0].generation,
    revision: 'revision-remote-update'
  }])));

  await heldLock.release();
  await staleDraft;
  assert.deepEqual(
    storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.url),
    ['https://remote.test']
  );
  await waitFor(() => heldLock.requested);
  await heldLock.release();
  await queuedDelete;
  assert.deepEqual(
    storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.url),
    ['https://remote.test']
  );
  assert.equal(storage.journalEntries().length, 0);
});

test('a retained stale delete cannot become the base of a later edit', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const renderer = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  storage.setFailJournalRemovals(true);
  const staleDelete = renderer.api.persist([], ['tab-1']);
  await waitFor(() => heldLock.requested);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://remote.test' },
    generation: initial.tabs[0].generation,
    revision: 'revision-remote-update'
  }])));
  await heldLock.release();
  await staleDelete;
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens.length, 1);

  const edit = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://my-edit.test' }
  ]);
  await waitFor(() => heldLock.requested);
  await heldLock.release();
  await edit;
  assert.deepEqual(
    storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.url),
    ['https://my-edit.test']
  );

  storage.setFailJournalRemovals(false);
  const restarted = createHarness({ storage, tabs: [], uuidPrefix: '22222222' });
  await restore(restarted);
  assert.deepEqual(
    storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.url),
    ['https://my-edit.test']
  );
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('a retained fork journal cannot redirect a later original-tab edit', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const renderer = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  storage.setFailJournalRemovals(true);
  const staleDraft = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://local-draft.test' }
  ]);
  await waitFor(() => heldLock.requested);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://remote.test' },
    generation: initial.tabs[0].generation,
    revision: 'revision-remote-update'
  }])));
  await heldLock.release();
  await staleDraft;
  let saved = storage.json(WORKSPACE_KEY);
  assert.deepEqual(
    saved.tabs.map(entry => entry.tab.url).sort(),
    ['https://local-draft.test', 'https://remote.test']
  );
  assert.equal(saved.retiredJournalTokens.length, 1);

  const originalEdit = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://edited-original.test' }
  ]);
  await waitFor(() => heldLock.requested);
  await heldLock.release();
  await originalEdit;
  saved = storage.json(WORKSPACE_KEY);
  assert.equal(saved.tabs.find(entry => entry.tab.id === 'tab-1').tab.url,
    'https://edited-original.test');
  assert.equal(saved.tabs.find(entry => entry.tab.id !== 'tab-1').tab.url,
    'https://local-draft.test');

  storage.setFailJournalRemovals(false);
  const restarted = createHarness({ storage, tabs: [], uuidPrefix: '22222222' });
  await restore(restarted);
  saved = storage.json(WORKSPACE_KEY);
  assert.equal(saved.tabs.find(entry => entry.tab.id === 'tab-1').tab.url,
    'https://edited-original.test');
  assert.equal(saved.tabs.find(entry => entry.tab.id !== 'tab-1').tab.url,
    'https://local-draft.test');
  assert.equal(saved.retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('an unchanged queued save advances the revision for a changed unload journal', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const harness = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  harness.api.restore();
  harness.api.load();

  harness.api.save();
  await waitFor(() => heldLock.requested);
  harness.setEditor({ method: 'POST', url: 'https://changed-after-no-op.test' });
  assert.equal(harness.api.unload(), true);
  assert.equal(storage.journalEntries().length, 2);

  await heldLock.release();
  await harness.api.settled();
  const stored = storage.json(WORKSPACE_KEY).tabs;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tab.url, 'https://changed-after-no-op.test');
  assert.equal(storage.journalEntries().length, 0);
});

test('an unchanged queued save advances the revision for a chained delete', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const harness = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  harness.api.restore();
  harness.api.load();

  harness.api.save();
  await waitFor(() => heldLock.requested);
  assert.equal(harness.api.stageDelete('tab-1'), true);
  assert.equal(storage.journalEntries().length, 2);

  await heldLock.release();
  await harness.api.settled();
  assert.equal(storage.json(WORKSPACE_KEY).tabs.length, 0);
  assert.equal(storage.journalEntries().length, 0);
});

test('a failed deletion workspace write retains the full chain for restart recovery', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const exiting = createHarness({ storage, locks: heldLock.manager, tabs: [initial.tabs[0].tab] });
  exiting.api.restore();
  exiting.api.load();

  exiting.api.save();
  await waitFor(() => heldLock.requested);
  assert.equal(exiting.api.stageDelete('tab-1'), true);
  storage.setFailWorkspaceWrites(true);

  await heldLock.release();
  await exiting.api.settled();
  assert.equal(storage.json(WORKSPACE_KEY).tabs.length, 1);
  assert.equal(storage.journalEntries().length, 2);

  storage.setFailWorkspaceWrites(false);
  const restarted = createHarness({
    storage,
    tabs: [{ id: 'tab-99', method: 'GET', url: '', headers: [], body: '' }],
    active: 'tab-99',
    uuidPrefix: '22222222'
  });
  await restore(restarted);

  const recoveredTabs = storage.json(WORKSPACE_KEY).tabs;
  assert.equal(recoveredTabs.some(entry => entry.tab.id === 'tab-1'), false);
  assert.equal(recoveredTabs.length, 1);
  assert.equal(recoveredTabs[0].tab.url, '');
  assert.equal(storage.journalEntries().length, 0);
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens, undefined);
});

test('stale unload replay forks exactly once after a remote revision', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const exiting = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(exiting);
  exiting.setEditor({ url: 'https://unload-draft.test' });
  exiting.api.unload();

  const remote = workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://remote.test' },
    generation: 'generation-tab-one',
    revision: 'revision-remote-new'
  }]);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(remote));

  const restarted = createHarness({
    storage,
    tabs: [{ id: 'tab-99', method: 'GET', url: '', headers: [], body: '' }],
    active: 'tab-99',
    uuidPrefix: '22222222'
  });
  await restore(restarted);
  assert.deepEqual(
    storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.url).sort(),
    ['https://remote.test', 'https://unload-draft.test']
  );
  assert.equal(storage.journalEntries().length, 0);

  const restartedAgain = createHarness({
    storage,
    tabs: [{ id: 'tab-100', method: 'GET', url: '', headers: [], body: '' }],
    active: 'tab-100',
    uuidPrefix: '33333333'
  });
  await restore(restartedAgain);
  assert.equal(storage.json(WORKSPACE_KEY).tabs.length, 2);
});

test('a queued delete journal is replayed after process exit', async () => {
  const initial = workspace([
    storedTab('tab-1', 'https://keep.test', 'tab-one'),
    storedTab('tab-2', 'https://delete.test', 'tab-two')
  ]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const exiting = createHarness({ storage, locks: heldLock.manager, tabs: initial.tabs.map(entry => entry.tab) });
  exiting.api.restore();
  exiting.api.load();
  exiting.api.persist([], ['tab-2']);
  await waitFor(() => heldLock.requested);
  assert.equal(storage.journalEntries().some(entry => entry.value.operation === 'delete'), true);

  const restarted = createHarness({ storage, tabs: initial.tabs.map(entry => entry.tab), uuidPrefix: '22222222' });
  await restore(restarted);
  assert.deepEqual(storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab.id), ['tab-1']);
  assert.equal(storage.journalEntries().length, 0);
});

test('a leftover create journal cannot resurrect a subsequently deleted tab', async () => {
  const initial = workspace([storedTab('tab-1', 'https://keep.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const renderer = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(renderer);
  const created = renderer.api.create();
  created.url = 'https://temporary.test';

  storage.setFailJournalRemovals(true);
  await renderer.api.persist([created]);
  assert.equal(storage.journalEntries().length, 1);
  await renderer.api.persist([], [created.id]);
  let saved = storage.json(WORKSPACE_KEY);
  assert.equal(saved.tabs.some(entry => entry.tab.id === created.id), false);
  assert.equal(saved.retiredJournalTokens.length, 1);

  storage.setFailJournalRemovals(false);
  const restarted = createHarness({ storage, tabs: [initial.tabs[0].tab], uuidPrefix: '22222222' });
  await restore(restarted);
  saved = storage.json(WORKSPACE_KEY);
  assert.equal(saved.tabs.some(entry => entry.tab.id === created.id), false);
  assert.equal(saved.retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('a leftover applied update chain cannot fork after the tab is deleted', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const renderer = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  storage.setFailJournalRemovals(true);
  await renderer.api.persist([{ ...initial.tabs[0].tab, url: 'https://applied-update.test' }]);
  assert.equal(storage.journalEntries().length, 1);
  await renderer.api.persist([], ['tab-1']);
  assert.equal(
    storage.json(WORKSPACE_KEY).tabs.some(entry =>
      entry.tab.id === 'tab-1' || entry.tab.url === 'https://applied-update.test'
    ),
    false
  );
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens.length, 1);

  storage.setFailJournalRemovals(false);
  const restarted = createHarness({ storage, tabs: [], uuidPrefix: '22222222' });
  await restore(restarted);
  assert.equal(
    storage.json(WORKSPACE_KEY).tabs.some(entry =>
      entry.tab.id === 'tab-1' || entry.tab.url === 'https://applied-update.test'
    ),
    false
  );
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('retained applied update ancestors cannot fork during later saves', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const renderer = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  storage.setFailJournalRemovals(true);
  for (const url of ['https://one.test', 'https://two.test', 'https://three.test']) {
    await renderer.api.persist([{ ...initial.tabs[0].tab, url }]);
  }
  let saved = storage.json(WORKSPACE_KEY);
  assert.deepEqual(saved.tabs.map(entry => entry.tab.url), ['https://three.test']);
  assert.equal(storage.journalEntries().length, 3);
  assert.equal(saved.retiredJournalTokens.length, 2);

  storage.setFailJournalRemovals(false);
  const restarted = createHarness({ storage, tabs: [], uuidPrefix: '22222222' });
  await restore(restarted);
  saved = storage.json(WORKSPACE_KEY);
  assert.deepEqual(saved.tabs.map(entry => entry.tab.url), ['https://three.test']);
  assert.equal(saved.retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('a selectively retained ancestor cannot become the base of a later save', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const renderer = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(renderer);

  storage.setFailJournalRemovals(true);
  await renderer.api.persist([{ ...initial.tabs[0].tab, url: 'https://one.test' }]);
  storage.setFailJournalRemovals(false);
  storage.failNextJournalRemovals();
  await renderer.api.persist([{ ...initial.tabs[0].tab, url: 'https://two.test' }]);
  assert.equal(storage.journalEntries().length, 1);
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens.length, 1);

  await renderer.api.persist([{ ...initial.tabs[0].tab, url: 'https://three.test' }]);
  const saved = storage.json(WORKSPACE_KEY);
  assert.deepEqual(saved.tabs.map(entry => entry.tab.url), ['https://three.test']);
  assert.equal(saved.retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('a retained acknowledged identical update cannot fork after later edits', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const heldLock = createHeldLock();
  const renderer = createHarness({
    storage,
    locks: heldLock.manager,
    tabs: [initial.tabs[0].tab]
  });
  await restore(renderer);

  storage.setFailJournalRemovals(true);
  const identicalSave = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://same.test' }
  ]);
  await waitFor(() => heldLock.requested);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace([{
    tab: { ...initial.tabs[0].tab, url: 'https://same.test' },
    generation: initial.tabs[0].generation,
    revision: 'revision-remote-identical'
  }])));
  await heldLock.release();
  await identicalSave;
  assert.equal(storage.journalEntries().length, 1);
  assert.equal(storage.json(WORKSPACE_KEY).retiredJournalTokens.length, 1);

  storage.setFailJournalRemovals(false);
  const changedSave = renderer.api.persist([
    { ...initial.tabs[0].tab, url: 'https://changed.test' }
  ]);
  await waitFor(() => heldLock.requested);
  await heldLock.release();
  await changedSave;
  const saved = storage.json(WORKSPACE_KEY);
  assert.deepEqual(saved.tabs.map(entry => entry.tab.url), ['https://changed.test']);
  assert.equal(saved.retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('durably retired journals are pre-cleaned when deletion recovery needs barrier capacity', async () => {
  const initial = {
    ...workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]),
    retiredJournalTokens: Array.from(
      { length: 1024 },
      (_, index) => `revision-retired-${String(index).padStart(4, '0')}`
    )
  };
  const retiredJournalEntries = initial.retiredJournalTokens.map((token, index) => {
    const id = `tab-${index + 100}`;
    const journal = {
      version: 2,
      token,
      writerId: 'writer-retired-00000001',
      writerSequence: index + 1,
      createdAt: index + 1,
      operation: 'create',
      id,
      generation: `generation-retired-${String(index).padStart(4, '0')}`,
      baseRevision: null,
      tab: { id, method: 'GET', url: `https://retired-${index}.test`, headers: [], body: '' }
    };
    return [`${JOURNAL_PREFIX}${id}:${token}`, JSON.stringify(journal)];
  });
  const storage = createStorage({
    [WORKSPACE_KEY]: JSON.stringify(initial),
    ...Object.fromEntries(retiredJournalEntries)
  });
  storage.setFailJournalRemovals(true);
  const renderer = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(renderer);
  assert.equal(storage.journalEntries().length, 1024);

  await renderer.api.persist([{ ...initial.tabs[0].tab, url: 'https://applied-update.test' }]);
  assert.equal(storage.journalEntries().length, 1025);
  await assert.rejects(
    renderer.api.persist([], ['tab-1']),
    /Send recovery metadata is full/
  );
  await renderer.api.settled();
  assert.equal(storage.json(WORKSPACE_KEY).tabs[0].tab.url, 'https://applied-update.test');
  assert.equal(storage.journalEntries().length, 1026);

  storage.setFailJournalRemovals(false);
  const restarted = createHarness({ storage, tabs: [], uuidPrefix: '22222222' });
  await restore(restarted);
  const recovered = storage.json(WORKSPACE_KEY);
  assert.equal(recovered.tabs.some(entry => entry.tab.id === 'tab-1'), false);
  assert.equal(recovered.tabs.length, 1);
  assert.equal(recovered.tabs[0].tab.url, '');
  assert.equal(recovered.retiredJournalTokens, undefined);
  assert.equal(storage.journalEntries().length, 0);
});

test('v1 journals migrate once without resurrecting a v2 tombstoned identity', async () => {
  const legacyToken = 'legacy-journal-token';
  const legacyKey = `${V1_JOURNAL_PREFIX}tab-2:${legacyToken}`;
  const storage = createStorage({
    [V2_WORKSPACE_KEY]: JSON.stringify({
      version: 2,
      tabs: [{ id: 'tab-1', method: 'GET', url: 'https://keep.test' }],
      deletedTabIds: ['tab-2']
    }),
    [legacyKey]: JSON.stringify({
      version: 1,
      token: legacyToken,
      createdAt: 1,
      id: 'tab-2',
      deleted: false,
      tab: { id: 'tab-2', method: 'POST', url: 'https://recovered-draft.test' }
    })
  });
  const renderer = createHarness({ storage, tabs: [], uuidPrefix: '11111111' });
  await restore(renderer);

  const tabs = storage.json(WORKSPACE_KEY).tabs.map(entry => entry.tab);
  assert.equal(tabs.some(tab => tab.id === 'tab-2'), false);
  assert.equal(tabs.some(tab => tab.url === 'https://recovered-draft.test'), true);
  assert.equal(storage.journalEntries(V1_JOURNAL_PREFIX).length, 0);
  assert.equal(storage.getItem(V2_WORKSPACE_KEY), null);
});

test('beforeunload blocks navigation when the final journal cannot be stored', async () => {
  const initial = workspace([storedTab('tab-1', 'https://initial.test', 'tab-one')]);
  const storage = createStorage({ [WORKSPACE_KEY]: JSON.stringify(initial) });
  const harness = createHarness({ storage, tabs: [initial.tabs[0].tab] });
  await restore(harness);
  storage.setFailJournalWrites(true);
  harness.setEditor({ url: 'https://must-not-be-lost.test' });
  let prevented = false;
  const event = { returnValue: undefined, preventDefault() { prevented = true; } };

  assert.equal(harness.api.unload(event), false);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  assert.equal(storage.journalEntries().length, 0);
});

test('Send persistence keeps the synchronous unload hook and live header capture', () => {
  const renderStart = source.indexOf('function renderSendHeaders()');
  const renderEnd = source.indexOf('function addSendHeader(', renderStart);
  const renderer = source.slice(renderStart, renderEnd);
  assert.match(renderer, /oninput="updateSendHeaderKey\(\$\{i\}, this\.value\)"/);
  assert.match(renderer, /oninput="updateSendHeaderVal\(\$\{i\}, this\.value\)"/);
  assert.match(source, /window\.addEventListener\('beforeunload', persistActiveSendTabBeforeUnload\)/);
  assert.match(source, /window\.prepareSendTabPersistenceForQuit = persistActiveSendTabBeforeUnload/);
});

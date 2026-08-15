import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const trafficListsStart = rendererSource.indexOf('let trafficListsSaveGeneration = 0;');
const trafficListsEnd = rendererSource.indexOf('// ============ ROW NAVIGATION', trafficListsStart);
assert.notEqual(trafficListsStart, -1);
assert.notEqual(trafficListsEnd, -1);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function response(lists, { ok = true, error = 'save failed', defaultPatterns } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => ok
      ? { success: true, lists: plain(lists), ...(defaultPatterns ? { defaultPatterns } : {}) }
      : { error }
  };
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.focusCalls = 0;
    this.selectCalls = 0;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : force;
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(' ');
        return enabled;
      }
    };
  }

  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (child && typeof child === 'object') child.parentNode = this;
      if (this.tagName === 'SELECT' && child?.selected) this.value = child.value;
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'id') this.id = stringValue;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = stringValue;
    }
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, type });
  }

  focus() {
    this.focusCalls++;
  }

  select() {
    this.selectCalls++;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = element => {
      for (const child of element.children || []) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function matchesSelector(element, selector) {
  const inputData = selector.match(/^input\[data-rule-index="([^"]+)"\]$/);
  if (inputData) {
    return element.tagName === 'INPUT' && element.dataset.ruleIndex === inputData[1];
  }
  if (selector.startsWith('.')) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  if (selector === '[data-traffic-lists-save]') {
    return Object.hasOwn(element.dataset, 'trafficListsSave');
  }
  return false;
}

class FakeDocument {
  constructor() {
    this.editor = new FakeElement('div');
    this.editor.id = 'trafficListsEditor';
    this.status = new FakeElement('span');
    this.status.id = 'trafficListsSaveStatus';
    this.saveButtons = [new FakeElement('button'), new FakeElement('button')];
    for (const button of this.saveButtons) button.dataset.trafficListsSave = '';
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    if (id === this.editor.id) return this.editor;
    if (id === this.status.id) return this.status;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '[data-traffic-lists-save]') return this.saveButtons;
    return this.editor.querySelectorAll(selector);
  }
}

const initialLists = [
  {
    id: 'default-exclusions',
    name: 'Default Exclusions',
    enabled: true,
    mode: 'blacklist',
    patterns: ['telemetry.example'],
    builtIn: true
  },
  {
    id: 'custom-list',
    name: 'Custom List',
    enabled: true,
    mode: 'blacklist',
    patterns: ['one.example', 'two.example'],
    builtIn: false
  }
];

function createRenderer(initial = initialLists) {
  const document = new FakeDocument();
  const toasts = [];
  const filterSnapshots = [];
  const pendingTimers = new Map();
  let nextTimerId = 1;
  let invalidationCalls = 0;
  const context = {
    API_BASE: '',
    console,
    confirm: () => true,
    document,
    fetch: async () => { throw new Error('Unexpected fetch'); },
    filterSnapshots,
    toast: (message, type) => toasts.push({ message, type }),
    invalidateCompiledTrafficLists: () => { invalidationCalls++; },
    safeLocalStorageGet: () => null,
    safeLocalStorageSet: () => true,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      pendingTimers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pendingTimers.delete(id);
    },
    window: { crypto: { randomUUID: () => 'generated-list' } }
  };
  vm.createContext(context);
  vm.runInContext(`
    const DEFAULT_TRAFFIC_LIST_ID = 'default-exclusions';
    let trafficLists = ${JSON.stringify(initial)};
    let trafficListDefaultPatterns = ['default-one.example', 'default-two.example'];
    let expandedTrafficListIds = new Set(trafficLists.map(list => list.id));
    let trafficListAccordionStateLoaded = true;
    function applyFilter() {
      filterSnapshots.push(JSON.stringify(trafficLists));
    }
    ${rendererSource.slice(trafficListsStart, trafficListsEnd)}
    Object.assign(globalThis, {
      testAddTrafficList: addTrafficList,
      testInsertTrafficListPattern: insertTrafficListPattern,
      testLoadTrafficLists: loadTrafficLists,
      testMarkTrafficListsChanged: markTrafficListsChanged,
      testRemoveTrafficList: removeTrafficList,
      testRemoveTrafficListPattern: removeTrafficListPattern,
      testRenderTrafficListsEditor: renderTrafficListsEditor,
      testResetDefaultTrafficList: resetDefaultTrafficList,
      testSaveTrafficLists: saveTrafficLists,
      testSetTrafficListsDirty: setTrafficListsDirty
    });
  `, context);

  function state() {
    return plain(vm.runInContext(`({
      lists: trafficLists,
      defaultPatterns: trafficListDefaultPatterns,
      dirty: trafficListsDirty,
      mutationGeneration: trafficListsMutationGeneration,
      stateGeneration: trafficListsStateGeneration,
      saveGeneration: trafficListsSaveGeneration
    })`, context));
  }

  function runTimers() {
    const timers = [...pendingTimers.values()];
    pendingTimers.clear();
    for (const { callback } of timers) callback();
  }

  return {
    context,
    document,
    filterSnapshots,
    pendingTimers,
    state,
    toasts,
    runTimers,
    get invalidationCalls() { return invalidationCalls; }
  };
}

function findControl(renderer, selector, listId = 'custom-list') {
  const card = renderer.document.editor.querySelectorAll('.traffic-list-editor-card')
    .find(candidate => candidate.dataset.listId === listId);
  assert.ok(card, `Missing rendered card ${listId}`);
  const control = card.querySelector(selector);
  assert.ok(control, `Missing rendered control ${selector}`);
  return control;
}

function editName(renderer, value) {
  const name = findControl(renderer, '.traffic-list-name-input');
  name.value = value;
  name.dispatch('input');
}

test('every traffic-list mutation advances the independent mutation generation', () => {
  const renderer = createRenderer();
  renderer.context.testRenderTrafficListsEditor();

  const mutate = action => {
    const before = renderer.state().mutationGeneration;
    action();
    assert.equal(renderer.state().mutationGeneration, before + 1);
    assert.equal(renderer.state().dirty, true);
    assert.equal(renderer.document.status.textContent, 'Unsaved changes');
    assert.ok(renderer.document.saveButtons.every(button => button.disabled === false));
  };

  mutate(() => {
    const rule = findControl(renderer, '.traffic-list-rule-input');
    rule.value = 'edited-rule.example';
    rule.dispatch('input');
  });
  assert.equal(renderer.invalidationCalls, 1);
  assert.equal(renderer.filterSnapshots.length, 0);
  assert.equal(renderer.pendingTimers.size, 1);
  mutate(() => {
    const enabled = findControl(renderer, '.traffic-list-enabled');
    enabled.checked = false;
    enabled.dispatch('change');
  });
  assert.equal(renderer.invalidationCalls, 2);
  assert.equal(renderer.filterSnapshots.length, 1);
  assert.equal(renderer.pendingTimers.size, 0);
  mutate(() => editName(renderer, 'Renamed List'));
  assert.equal(renderer.invalidationCalls, 2);
  assert.equal(renderer.filterSnapshots.length, 1);
  assert.equal(renderer.pendingTimers.size, 0);
  mutate(() => {
    const mode = findControl(renderer, '.traffic-list-mode-select');
    mode.value = 'whitelist';
    mode.dispatch('change');
  });
  assert.equal(renderer.invalidationCalls, 3);
  assert.equal(renderer.filterSnapshots.length, 2);
  mutate(() => renderer.context.testInsertTrafficListPattern('custom-list', 0));
  assert.equal(renderer.invalidationCalls, 4);
  assert.equal(renderer.filterSnapshots.length, 3);
  mutate(() => renderer.context.testRemoveTrafficListPattern('custom-list', 1));
  assert.equal(renderer.invalidationCalls, 5);
  assert.equal(renderer.filterSnapshots.length, 4);
  mutate(() => renderer.context.testAddTrafficList());
  assert.equal(renderer.invalidationCalls, 6);
  assert.equal(renderer.filterSnapshots.length, 5);
  mutate(() => renderer.context.testRemoveTrafficList('list-generated-list'));
  assert.equal(renderer.invalidationCalls, 7);
  assert.equal(renderer.filterSnapshots.length, 6);
  mutate(() => renderer.context.testResetDefaultTrafficList());
  assert.equal(renderer.invalidationCalls, 8);
  assert.equal(renderer.filterSnapshots.length, 7);
  assert.equal(renderer.pendingTimers.size, 0);

  assert.deepEqual(renderer.state().lists[0].patterns, [
    'default-one.example',
    'default-two.example'
  ]);
});

for (const result of ['success', 'failure']) {
  test(`edits made during a ${result === 'success' ? 'successful' : 'failed'} save remain live and dirty`, async () => {
    const renderer = createRenderer();
    renderer.context.testRenderTrafficListsEditor();
    editName(renderer, 'Submitted name');
    const request = deferred();
    const requestBodies = [];
    renderer.context.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return request.promise;
    };

    const save = renderer.context.testSaveTrafficLists();
    const rule = findControl(renderer, '.traffic-list-rule-input');
    rule.value = 'newer-local.example';
    rule.dispatch('input');
    assert.equal(renderer.pendingTimers.size, 1);

    request.resolve(result === 'success'
      ? response(requestBodies[0].lists.map(list => ({ ...list, name: list.name.trim() })))
      : response([], { ok: false, error: 'disk full' }));
    await save;

    assert.equal(requestBodies[0].lists[1].name, 'Submitted name');
    assert.equal(requestBodies[0].lists[1].patterns[0], 'one.example');
    assert.equal(renderer.state().lists[1].patterns[0], 'newer-local.example');
    assert.equal(renderer.state().dirty, true);
    assert.equal(renderer.document.status.textContent, 'Unsaved changes');
    assert.ok(renderer.document.saveButtons.every(button => button.disabled === false));
    assert.equal(renderer.pendingTimers.size, 1);

    assert.deepEqual(renderer.toasts, result === 'success'
      ? [{
          message: 'Traffic list snapshot saved; newer local changes remain unsaved',
          type: 'success'
        }]
      : [{
          message: 'Error: disk full. The submitted snapshot and newer local changes remain unsaved.',
          type: 'error'
        }]);

    const filterCallsBeforeTimer = renderer.filterSnapshots.length;
    renderer.runTimers();
    assert.equal(renderer.filterSnapshots.length, filterCallsBeforeTimer + 1);
    assert.equal(JSON.parse(renderer.filterSnapshots.at(-1))[1].patterns[0], 'newer-local.example');
  });
}

test('an unmodified submitted snapshot still adopts the confirmed server response', async () => {
  const renderer = createRenderer();
  renderer.context.testRenderTrafficListsEditor();
  editName(renderer, '  Submitted name  ');
  let requestBody;
  renderer.context.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const confirmed = requestBody.lists.map(list => ({ ...list, name: list.name.trim() }));
    return response(confirmed);
  };

  await renderer.context.testSaveTrafficLists();

  assert.equal(requestBody.lists[1].name, '  Submitted name  ');
  assert.equal(renderer.state().lists[1].name, 'Submitted name');
  assert.equal(renderer.state().dirty, false);
  assert.equal(renderer.document.status.textContent, 'All changes saved');
  assert.ok(renderer.document.saveButtons.every(button => button.disabled === true));
  assert.deepEqual(renderer.toasts, [{ message: 'Traffic lists saved', type: 'success' }]);
});

test('a load response cannot overwrite an edit or cancel its delayed filter refresh', async () => {
  const renderer = createRenderer();
  const request = deferred();
  renderer.context.fetch = async () => request.promise;
  const load = renderer.context.testLoadTrafficLists();

  const rule = findControl(renderer, '.traffic-list-rule-input');
  rule.value = 'edited-during-load.example';
  rule.dispatch('input');
  request.resolve(response([{
    ...initialLists[0],
    name: 'Server default'
  }, {
    ...initialLists[1],
    name: 'Server custom',
    patterns: ['server.example']
  }], { defaultPatterns: ['server-default.example'] }));
  await load;

  assert.equal(renderer.state().lists[1].name, 'Custom List');
  assert.equal(renderer.state().lists[1].patterns[0], 'edited-during-load.example');
  assert.deepEqual(renderer.state().defaultPatterns, [
    'default-one.example',
    'default-two.example'
  ]);
  assert.equal(renderer.state().dirty, true);
  assert.equal(renderer.pendingTimers.size, 1);
  renderer.runTimers();
  assert.equal(JSON.parse(renderer.filterSnapshots.at(-1))[1].patterns[0],
    'edited-during-load.example');
});

test('a GET started during a save cannot roll back the confirmed snapshot', async () => {
  const renderer = createRenderer();
  renderer.context.testRenderTrafficListsEditor();
  editName(renderer, 'Saved by PUT');
  const putRequest = deferred();
  const getRequest = deferred();
  let submittedLists;
  renderer.context.fetch = async (_url, options = {}) => {
    if (options.method === 'PUT') {
      submittedLists = JSON.parse(options.body).lists;
      return putRequest.promise;
    }
    return getRequest.promise;
  };

  const save = renderer.context.testSaveTrafficLists();
  const load = renderer.context.testLoadTrafficLists();
  putRequest.resolve(response(submittedLists));
  await save;
  assert.equal(renderer.state().lists[1].name, 'Saved by PUT');
  assert.equal(renderer.state().dirty, false);

  getRequest.resolve(response(initialLists.map(list => ({ ...list, name: 'Stale GET' })), {
    defaultPatterns: ['stale-default.example']
  }));
  await load;

  assert.equal(renderer.state().lists[1].name, 'Saved by PUT');
  assert.deepEqual(renderer.state().defaultPatterns, [
    'default-one.example',
    'default-two.example'
  ]);
  assert.equal(renderer.state().dirty, false);
  assert.deepEqual(renderer.toasts, [{ message: 'Traffic lists saved', type: 'success' }]);
});

for (const order of [['older', 'newer'], ['newer', 'older']]) {
  test(`only the newest concurrent load applies when ${order[0]} resolves first`, async () => {
    const renderer = createRenderer();
    const older = deferred();
    const newer = deferred();
    let requestCount = 0;
    renderer.context.fetch = async () => (++requestCount === 1 ? older : newer).promise;
    const olderLoad = renderer.context.testLoadTrafficLists();
    const newerLoad = renderer.context.testLoadTrafficLists();
    const releases = {
      older: () => older.resolve(response(initialLists.map(list => ({
        ...list,
        name: 'Older load'
      })), { defaultPatterns: ['older-default.example'] })),
      newer: () => newer.resolve(response(initialLists.map(list => ({
        ...list,
        name: 'Newest load'
      })), { defaultPatterns: ['newest-default.example'] }))
    };
    const loads = { older: olderLoad, newer: newerLoad };

    for (const label of order) {
      releases[label]();
      await loads[label];
    }

    assert.ok(renderer.state().lists.every(list => list.name === 'Newest load'));
    assert.deepEqual(renderer.state().defaultPatterns, ['newest-default.example']);
    assert.equal(renderer.state().dirty, false);
  });
}

test('latest overlapping save can clean state and an older late success cannot roll it back', async () => {
  const renderer = createRenderer();
  renderer.context.testRenderTrafficListsEditor();
  const older = deferred();
  const newer = deferred();
  const requestBodies = [];
  let requestCount = 0;
  renderer.context.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return (++requestCount === 1 ? older : newer).promise;
  };

  editName(renderer, 'First snapshot');
  const olderSave = renderer.context.testSaveTrafficLists();
  editName(renderer, 'Second snapshot');
  const newerSave = renderer.context.testSaveTrafficLists();
  const confirmedLatest = requestBodies[1].lists.map(list => ({ ...list }));
  confirmedLatest[1].name = 'Canonical second snapshot';
  newer.resolve(response(confirmedLatest));
  await newerSave;

  assert.equal(renderer.state().lists[1].name, 'Canonical second snapshot');
  assert.equal(renderer.state().dirty, false);
  assert.ok(renderer.document.saveButtons.every(button => button.disabled === true));
  assert.deepEqual(renderer.toasts, [{ message: 'Traffic lists saved', type: 'success' }]);

  older.resolve(response(requestBodies[0].lists));
  await olderSave;
  assert.equal(renderer.state().lists[1].name, 'Canonical second snapshot');
  assert.equal(renderer.state().dirty, false);
  assert.deepEqual(renderer.toasts, [{ message: 'Traffic lists saved', type: 'success' }]);
});

test('latest failed save remains dirty after an older late success', async () => {
  const renderer = createRenderer();
  renderer.context.testRenderTrafficListsEditor();
  const older = deferred();
  const newer = deferred();
  const requestBodies = [];
  let requestCount = 0;
  renderer.context.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return (++requestCount === 1 ? older : newer).promise;
  };

  editName(renderer, 'First snapshot');
  const olderSave = renderer.context.testSaveTrafficLists();
  editName(renderer, 'Second snapshot');
  const newerSave = renderer.context.testSaveTrafficLists();
  newer.resolve(response([], { ok: false, error: 'newer failed' }));
  await newerSave;

  assert.equal(renderer.state().lists[1].name, 'Second snapshot');
  assert.equal(renderer.state().dirty, true);
  assert.ok(renderer.document.saveButtons.every(button => button.disabled === false));
  assert.deepEqual(renderer.toasts, [{ message: 'Error: newer failed', type: 'error' }]);

  older.resolve(response(requestBodies[0].lists));
  await olderSave;
  assert.equal(renderer.state().lists[1].name, 'Second snapshot');
  assert.equal(renderer.state().dirty, true);
  assert.deepEqual(renderer.toasts, [{ message: 'Error: newer failed', type: 'error' }]);
});

for (const scenario of [
  { name: 'older success before newer failure', order: ['older', 'newer'], olderOk: true, newerOk: false },
  { name: 'newer success before older failure', order: ['newer', 'older'], olderOk: false, newerOk: true }
]) {
  test(`overlapping saves ignore stale responses: ${scenario.name}`, async () => {
    const renderer = createRenderer();
    renderer.context.testRenderTrafficListsEditor();
    const older = deferred();
    const newer = deferred();
    const requestBodies = [];
    let requestCount = 0;
    renderer.context.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return (++requestCount === 1 ? older : newer).promise;
    };

    editName(renderer, 'First snapshot');
    const olderSave = renderer.context.testSaveTrafficLists();
    editName(renderer, 'Second snapshot');
    const newerSave = renderer.context.testSaveTrafficLists();
    editName(renderer, 'Newest local edit');

    const releases = {
      older: () => older.resolve(scenario.olderOk
        ? response(requestBodies[0].lists)
        : response([], { ok: false, error: 'older failed' })),
      newer: () => newer.resolve(scenario.newerOk
        ? response(requestBodies[1].lists)
        : response([], { ok: false, error: 'newer failed' }))
    };
    const saves = { older: olderSave, newer: newerSave };
    for (const label of scenario.order) {
      releases[label]();
      await saves[label];
    }

    assert.equal(requestBodies[0].lists[1].name, 'First snapshot');
    assert.equal(requestBodies[1].lists[1].name, 'Second snapshot');
    assert.equal(renderer.state().lists[1].name, 'Newest local edit');
    assert.equal(renderer.state().dirty, true);
    assert.ok(renderer.document.saveButtons.every(button => button.disabled === false));
    assert.deepEqual(renderer.toasts, scenario.newerOk
      ? [{
          message: 'Traffic list snapshot saved; newer local changes remain unsaved',
          type: 'success'
        }]
      : [{
          message: 'Error: newer failed. The submitted snapshot and newer local changes remain unsaved.',
          type: 'error'
        }]);
  });
}

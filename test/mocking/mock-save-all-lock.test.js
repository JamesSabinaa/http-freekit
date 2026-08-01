import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'styles.css'), 'utf8');
const markup = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');
const saveFunctionsStart = source.indexOf('async function saveAllMockRules()');
const saveFunctionsEnd = source.indexOf('function _mockRevertStateToken()', saveFunctionsStart);
const saveFunctionsSource = source.slice(saveFunctionsStart, saveFunctionsEnd);
const queueStart = source.indexOf('function _queueMockCollectionMutation(mutation)');
const queueEnd = source.indexOf('function mockDrop', queueStart);
const queueSource = source.slice(queueStart, queueEnd);
const createMockStart = source.indexOf('function copyResponseHeadersForMock(headers)');
const createMockEnd = source.indexOf('// --- Header context menu', createMockStart);
const createMockSource = source.slice(createMockStart, createMockEnd);
const breakpointMutationStart = source.indexOf('async function toggleBreakpointRuleEnabled(ruleId)');
const breakpointMutationEnd = source.indexOf('function renderMockRuleDetail', breakpointMutationStart);
const breakpointMutationSource = source.slice(breakpointMutationStart, breakpointMutationEnd);
const importStart = source.indexOf('function importMockRules()');
const importEnd = source.indexOf('// ============ TRANSFORM HEADER HELPERS', importStart);
const importSource = source.slice(importStart, importEnd);
const ensureDefaultStart = source.indexOf('async function ensureDefaultMockRules()');
const ensureDefaultEnd = source.indexOf('function normalizeMockRule', ensureDefaultStart);
const ensureDefaultSource = source.slice(ensureDefaultStart, ensureDefaultEnd);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createSaveHarness({ resetInProgress = false, collectionMutationCount = 0 } = {}) {
  const response = deferred();
  const calls = { fetch: 0, load: 0, updates: 0 };
  const context = {
    calls,
    fetch: () => {
      calls.fetch++;
      return response.promise;
    }
  };
  vm.runInNewContext(`
    const API_BASE = 'http://api.test';
    const mockDraftRules = new Map([['new-draft', {
      id: 'new-draft',
      matchers: [{ type: 'wildcard' }],
      action: { type: 'passthrough' }
    }]]);
    const mockNewDraftIds = new Set(['new-draft']);
    let mockEditingRule = null;
    let mockEditDraft = null;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = ${resetInProgress};
    let mockCollectionMutationCount = ${collectionMutationCount};
    function hasOpenMockEditChanges() { return false; }
    function hasUnsavedMockChanges() { return mockDraftRules.size > 0; }
    function saveMockRule() { return true; }
    function toast() {}
    function updateMockSaveButtons() { calls.updates++; }
    async function loadMockRules() { calls.load++; }
    ${saveFunctionsSource}
    globalThis.harness = {
      saveAllMockRules,
      saveOneMockRule,
      state: () => ({
        draftCount: mockDraftRules.size,
        saveInProgress: mockSaveInProgress
      })
    };
  `, context);
  return { calls, response, harness: context.harness };
}

function createExistingDraftHarness() {
  const response = deferred();
  const calls = { fetch: 0 };
  const saveOneStart = source.indexOf('async function saveOneMockRule(draftId)');
  const saveOneEnd = source.indexOf('function _mockRevertStateToken()', saveOneStart);
  const saveOneSource = source.slice(saveOneStart, saveOneEnd);
  const toggleStart = source.indexOf('function toggleMockRuleEnabled(ruleId)');
  const toggleEnd = source.indexOf('function updateMockMatcher', toggleStart);
  const toggleSource = source.slice(toggleStart, toggleEnd);
  const context = {
    calls,
    fetch: () => {
      calls.fetch++;
      return response.promise;
    }
  };
  vm.runInNewContext(`
    const API_BASE = 'http://api.test';
    const draft = {
      id: 'saved-draft',
      enabled: true,
      matchers: [{ type: 'wildcard' }],
      action: { type: 'passthrough' }
    };
    const mockDraftRules = new Map([['saved-draft', draft]]);
    const mockNewDraftIds = new Set();
    const mockRules = [draft];
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    function _findMockRuleDeep(ruleId) { return mockRules.find(rule => rule.id === ruleId); }
    function updateMockSaveButtons() {}
    function renderMockRules() {}
    function toast() {}
    async function loadMockRules() {}
    ${toggleSource}
    ${saveOneSource}
    globalThis.harness = {
      saveOneMockRule,
      toggleMockRuleEnabled,
      state: () => ({
        draftCount: mockDraftRules.size,
        enabled: mockRules[0].enabled,
        saveInProgress: mockSaveInProgress
      })
    };
  `, context);
  return { calls, response, harness: context.harness };
}

function createTrafficMockHarness() {
  const response = deferred();
  const calls = { fetch: 0, load: 0, updates: 0 };
  const context = {
    calls,
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    },
    fetch: () => {
      calls.fetch++;
      return response.promise;
    },
    setTimeout: () => {}
  };
  vm.runInNewContext(`
    const API_BASE = 'http://api.test';
    let mockRules = [];
    let defaultsCreated = false;
    const request = {
      id: 'exchange',
      method: 'GET',
      host: 'example.test',
      path: '/resource?view=full',
      requestBody: '',
      responseBody: 'created response',
      responseHeaders: { 'content-type': 'text/plain' },
      statusCode: 201
    };
    const mockDraftRules = new Map([['new-draft', {
      id: 'new-draft',
      matchers: [{ type: 'wildcard' }],
      action: { type: 'passthrough' }
    }]]);
    const mockNewDraftIds = new Set(['new-draft']);
    let mockEditingRule = null;
    let mockEditDraft = null;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    let mockReorderQueue = Promise.resolve();
    function trafficActionRequest(requestId) { return requestId === request.id ? request : null; }
    function hasOpenMockEditChanges() { return false; }
    function hasUnsavedMockChanges() { return mockDraftRules.size > 0; }
    function saveMockRule() { return true; }
    function editMockRule() {}
    function switchPanel() {}
    function toast() {}
    function updateMockSaveButtons() { calls.updates++; }
    async function loadMockRules() { calls.load++; }
    function safeLocalStorageGet() { return defaultsCreated ? 'true' : null; }
    function safeLocalStorageSet() { defaultsCreated = true; }
    function _createDefaultMockRule() {
      return { matchers: [{ type: 'method', value: '*' }], action: { type: 'passthrough' } };
    }
    async function _readMockRulesResponse(response) { return response.json(); }
    ${queueSource}
    ${saveFunctionsSource}
    ${createMockSource}
    ${ensureDefaultSource}
    globalThis.harness = {
      createMockFromRequest,
      ensureDefaultMockRules,
      saveAllMockRules,
      state: () => ({
        collectionMutationCount: mockCollectionMutationCount,
        draftCount: mockDraftRules.size,
        saveInProgress: mockSaveInProgress
      })
    };
  `, context);
  return { calls, response, harness: context.harness };
}

function createBreakpointImportHarness() {
  const response = deferred();
  const calls = { createInput: 0, fetch: 0, loadBreakpoints: 0, loadMocks: 0 };
  let fileInput = null;
  const context = {
    calls,
    confirm: () => false,
    document: {
      createElement: () => {
        calls.createInput++;
        fileInput = { click: () => {} };
        return fileInput;
      }
    },
    fetch: () => {
      calls.fetch++;
      return response.promise;
    }
  };
  vm.runInNewContext(`
    const API_BASE = 'http://api.test';
    const mockRules = [];
    let breakpointRules = [{ id: 'breakpoint-1', enabled: true }];
    const mockDraftRules = new Map();
    const mockNewDraftIds = new Set();
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    let mockReorderQueue = Promise.resolve();
    function toast() {}
    function updateMockSaveButtons() {}
    async function loadMockRules() { calls.loadMocks++; }
    async function loadBreakpointRules() { calls.loadBreakpoints++; }
    ${queueSource}
    ${breakpointMutationSource}
    ${importSource}
    globalThis.harness = {
      importMockRules,
      toggleBreakpointRuleEnabled,
      state: () => ({ collectionMutationCount: mockCollectionMutationCount })
    };
  `, context);
  return {
    calls,
    response,
    harness: context.harness,
    getFileInput: () => fileInput
  };
}

test('Save All rejects concurrent invocations and disables its button', () => {
  const start = source.indexOf('async function saveAllMockRules()');
  const end = source.indexOf('/** Send a single draft rule', start);
  const saveAllSource = source.slice(start, end);
  const buttonsStart = source.indexOf('function updateMockSaveButtons()');
  const buttonsEnd = source.indexOf('async function deleteMockRule', buttonsStart);
  const buttonsSource = source.slice(buttonsStart, buttonsEnd);

  assert.match(
    saveAllSource,
    /if\s*\(\s*mockSaveInProgress(?:\s*\|\|[^)]*)?\)\s*return/
  );
  assert.match(saveAllSource, /mockSaveInProgress = true/);
  assert.match(saveAllSource, /finally\s*{[\s\S]*mockSaveInProgress = false/);
  assert.match(buttonsSource, /saveAllBtn\.disabled = serverMutationLocked/);
});

test('all Save-to-server entry points share one in-flight lock', async () => {
  const singleFirst = createSaveHarness();
  const singleRequest = singleFirst.harness.saveOneMockRule('new-draft');
  const duplicateSingle = singleFirst.harness.saveOneMockRule('new-draft');
  const overlappingAll = singleFirst.harness.saveAllMockRules();
  assert.equal(singleFirst.calls.fetch, 1);
  singleFirst.response.resolve({ ok: true, json: async () => ({ id: 'server-rule' }) });
  await Promise.all([singleRequest, duplicateSingle, overlappingAll]);
  assert.equal(singleFirst.harness.state().draftCount, 0);
  assert.equal(singleFirst.harness.state().saveInProgress, false);

  const allFirst = createSaveHarness();
  const allRequest = allFirst.harness.saveAllMockRules();
  const overlappingSingle = allFirst.harness.saveOneMockRule('new-draft');
  const duplicateAll = allFirst.harness.saveAllMockRules();
  assert.equal(allFirst.calls.fetch, 1);
  allFirst.response.resolve({ ok: true, json: async () => ({ id: 'server-rule' }) });
  await Promise.all([allRequest, overlappingSingle, duplicateAll]);
  assert.equal(allFirst.harness.state().draftCount, 0);
  assert.equal(allFirst.harness.state().saveInProgress, false);
});

test('the mock workspace and direct mutations follow the shared save lock', () => {
  const rowStart = source.indexOf('function renderMockRuleRow(rule)');
  const rowEnd = source.indexOf('function renderMockGroup(group)', rowStart);
  const rowSource = source.slice(rowStart, rowEnd);
  const buttonsStart = source.indexOf('function updateMockSaveButtons()');
  const buttonsEnd = source.indexOf('async function deleteMockRule', buttonsStart);
  const buttonsSource = source.slice(buttonsStart, buttonsEnd);

  assert.match(rowSource, /mock-save-server[\s\S]{0,300}serverMutationDisabledAttr/);
  assert.match(rowSource, /mock-rule-delete[\s\S]{0,300}serverMutationDisabledAttr/);
  assert.match(buttonsSource, /classList\?\.toggle\('mock-server-save-locked', serverMutationLocked\)/);
  assert.match(buttonsSource, /querySelectorAll\?\.\('button, input, select, textarea'\)/);
  assert.match(buttonsSource, /setAttribute\?\.\('aria-busy', String\(serverMutationLocked\)\)/);
  assert.match(styles, /\.mock-rules-list\.mock-server-save-locked \.mock-rule-card[\s\S]*pointer-events: none/);
  const deleteGroupStart = source.indexOf('async function deleteMockGroup(groupId)');
  const deleteGroupEnd = source.indexOf('async function createMockGroup()', deleteGroupStart);
  assert.match(
    source.slice(deleteGroupStart, deleteGroupEnd),
    /if \(mockSaveInProgress \|\| mockRevertInProgress \|\| mockResetInProgress \|\| mockCollectionMutationCount > 0\) return/
  );
});

test('Reset and queued collection mutations own the workspace before Save begins', async () => {
  const resetFirst = createSaveHarness({ resetInProgress: true });
  await Promise.all([
    resetFirst.harness.saveAllMockRules(),
    resetFirst.harness.saveOneMockRule('new-draft')
  ]);
  assert.equal(resetFirst.calls.fetch, 0);
  assert.equal(resetFirst.harness.state().draftCount, 1);

  const collectionFirst = createSaveHarness({ collectionMutationCount: 1 });
  await Promise.all([
    collectionFirst.harness.saveAllMockRules(),
    collectionFirst.harness.saveOneMockRule('new-draft')
  ]);
  assert.equal(collectionFirst.calls.fetch, 0);
  assert.equal(collectionFirst.harness.state().draftCount, 1);

  assert.match(queueSource, /mockCollectionMutationCount\+\+/);
  assert.match(queueSource, /finally\(\(\) => \{[\s\S]*mockCollectionMutationCount--/);
});

test('save ownership protects Collapse All and Import toolbar actions', () => {
  const collapseStart = source.indexOf('function collapseAllMockRules()');
  const collapseEnd = source.indexOf('function mockDragStart', collapseStart);
  const collapseSource = source.slice(collapseStart, collapseEnd);
  assert.match(collapseSource, /mockSaveInProgress[\s\S]*mockCollectionMutationCount > 0\) return/);

  assert.match(importSource, /mockSaveInProgress[\s\S]*mockCollectionMutationCount > 0\) return/);

  for (const id of ['mockCreateGroupBtn', 'mockCollapseAllBtn', 'mockImportBtn', 'mockResetBtn']) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
  const buttonsStart = source.indexOf('function updateMockSaveButtons()');
  const buttonsEnd = source.indexOf('async function deleteMockRule', buttonsStart);
  const buttonsSource = source.slice(buttonsStart, buttonsEnd);
  assert.match(buttonsSource, /\['mockCreateGroupBtn', 'mockCollapseAllBtn', 'mockImportBtn', 'mockResetBtn'\]/);
  assert.match(buttonsSource, /control\.disabled = serverMutationLocked/);
});

test('an owned save blocks a newer toggle instead of silently discarding it', async () => {
  const save = createExistingDraftHarness();
  const request = save.harness.saveOneMockRule('saved-draft');
  assert.equal(save.calls.fetch, 1);

  save.harness.toggleMockRuleEnabled('saved-draft');
  assert.equal(save.harness.state().enabled, true);
  assert.equal(save.harness.state().draftCount, 1);
  assert.equal(save.harness.state().saveInProgress, true);

  save.response.resolve({ ok: true, json: async () => ({ success: true }) });
  await request;
  assert.equal(save.harness.state().draftCount, 0);
  assert.equal(save.harness.state().saveInProgress, false);
});

test('traffic-derived mock creation and Save All exclude each other in request order', async () => {
  const saveFirst = createTrafficMockHarness();
  const saveRequest = saveFirst.harness.saveAllMockRules();
  const blockedCreate = saveFirst.harness.createMockFromRequest('exchange');
  assert.equal(blockedCreate, undefined);
  assert.equal(saveFirst.calls.fetch, 1);
  saveFirst.response.resolve({
    ok: true,
    json: async () => ({ id: 'saved-rule', rule: { id: 'saved-rule' } })
  });
  await saveRequest;
  assert.equal(saveFirst.harness.state().draftCount, 0);

  const createFirst = createTrafficMockHarness();
  const createRequest = createFirst.harness.createMockFromRequest('exchange');
  assert.equal(createFirst.harness.state().collectionMutationCount, 1);
  const blockedSave = createFirst.harness.saveAllMockRules();
  await Promise.resolve();
  assert.equal(createFirst.calls.fetch, 1);
  createFirst.response.resolve({
    ok: true,
    json: async () => ({ rule: { id: 'derived-rule' } })
  });
  await Promise.all([createRequest, blockedSave]);
  assert.equal(createFirst.harness.state().draftCount, 1);
  assert.equal(createFirst.harness.state().collectionMutationCount, 0);
});

test('automatic default creation and traffic-derived creation exclude each other', async () => {
  const defaultFirst = createTrafficMockHarness();
  const defaultRequest = defaultFirst.harness.ensureDefaultMockRules();
  assert.equal(defaultFirst.harness.state().collectionMutationCount, 1);
  const blockedCreate = defaultFirst.harness.createMockFromRequest('exchange');
  assert.equal(blockedCreate, undefined);
  await Promise.resolve();
  assert.equal(defaultFirst.calls.fetch, 1);
  defaultFirst.response.resolve({
    ok: true,
    json: async () => ({ success: true, rule: { id: 'default-rule' } })
  });
  await defaultRequest;
  assert.equal(defaultFirst.harness.state().collectionMutationCount, 0);

  const createFirst = createTrafficMockHarness();
  const createRequest = createFirst.harness.createMockFromRequest('exchange');
  assert.equal(createFirst.harness.state().collectionMutationCount, 1);
  const blockedDefault = createFirst.harness.ensureDefaultMockRules();
  await blockedDefault;
  await Promise.resolve();
  assert.equal(createFirst.calls.fetch, 1);
  createFirst.response.resolve({
    ok: true,
    json: async () => ({ rule: { id: 'derived-rule' } })
  });
  await createRequest;
  assert.equal(createFirst.harness.state().collectionMutationCount, 0);
});

test('breakpoint mutation and v2 Import exclude each other in request order', async () => {
  const breakpointFirst = createBreakpointImportHarness();
  const toggleRequest = breakpointFirst.harness.toggleBreakpointRuleEnabled('breakpoint-1');
  assert.equal(breakpointFirst.harness.state().collectionMutationCount, 1);
  breakpointFirst.harness.importMockRules();
  assert.equal(breakpointFirst.calls.createInput, 0);
  await Promise.resolve();
  assert.equal(breakpointFirst.calls.fetch, 1);
  breakpointFirst.response.resolve({ ok: true, json: async () => ({}) });
  await toggleRequest;

  const importFirst = createBreakpointImportHarness();
  importFirst.harness.importMockRules();
  const fileInput = importFirst.getFileInput();
  assert.ok(fileInput);
  const importRequest = fileInput.onchange({
    target: {
      files: [{
        text: async () => JSON.stringify({ version: 2, mockRules: [], breakpointRules: [] })
      }]
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(importFirst.harness.state().collectionMutationCount, 1);
  const blockedToggle = importFirst.harness.toggleBreakpointRuleEnabled('breakpoint-1');
  await Promise.resolve();
  assert.equal(importFirst.calls.fetch, 1);
  importFirst.response.resolve({
    ok: true,
    json: async () => ({ success: true, mockRules: [], breakpointRules: [] })
  });
  await Promise.all([importRequest, blockedToggle]);
  assert.equal(importFirst.harness.state().collectionMutationCount, 0);
});

test('all breakpoint collection handlers use the shared mutation owner', () => {
  const rowStart = source.indexOf('function renderBreakpointRuleRow(rule)');
  const rowEnd = source.indexOf('function renderMockRuleDetail', rowStart);
  const rowSource = source.slice(rowStart, rowEnd);
  const createBreakpointStart = source.indexOf('function createBreakpointFromRequest(');
  const createBreakpointEnd = source.indexOf('function toast(', createBreakpointStart);
  const createBreakpointSource = source.slice(createBreakpointStart, createBreakpointEnd);

  for (const handlerSource of [breakpointMutationSource, createBreakpointSource]) {
    assert.match(
      handlerSource,
      /mockSaveInProgress \|\| mockRevertInProgress \|\| mockResetInProgress \|\| mockCollectionMutationCount > 0/
    );
    assert.match(handlerSource, /_queueMockCollectionMutation/);
  }
  assert.match(rowSource, /data-mock-save-lock-disabled="true"/);
});

test('Save All removes each successful draft before another request can fail', () => {
  const start = source.indexOf('async function saveAllMockRules()');
  const end = source.indexOf('/** Send a single draft rule', start);
  const saveAllSource = source.slice(start, end);
  const loopStart = saveAllSource.indexOf('for (const [draftId, draft] of entries)');
  const catchStart = saveAllSource.indexOf('} catch (err)');
  const loopSource = saveAllSource.slice(loopStart, catchStart);

  assert.match(loopSource, /mockDraftRules\.delete\(draftId\)/);
  assert.match(loopSource, /mockNewDraftIds\.delete\(draftId\)/);
  assert.doesNotMatch(saveAllSource.slice(catchStart), /mockDraftRules\.clear/);
});

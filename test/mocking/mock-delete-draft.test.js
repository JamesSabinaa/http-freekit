import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const functionStart = source.indexOf('async function deleteMockRule(ruleId)');
const functionEnd = source.indexOf('function cloneMockRule', functionStart);
const queueStart = source.indexOf('function _queueMockCollectionMutation(mutation)');
const queueEnd = source.indexOf('function mockDrop', queueStart);
const deleteMockGroupStart = source.indexOf('async function deleteMockGroup(groupId)');
const deleteMockGroupEnd = source.indexOf('async function createMockGroup()', deleteMockGroupStart);
assert.notEqual(functionStart, -1);
assert.notEqual(functionEnd, -1);
assert.notEqual(deleteMockGroupStart, -1);
assert.notEqual(deleteMockGroupEnd, -1);
const deleteMockRuleSource = source.slice(functionStart, functionEnd);
const queueMockCollectionMutationSource = source.slice(queueStart, queueEnd);
const deleteMockGroupSource = source.slice(deleteMockGroupStart, deleteMockGroupEnd);

function createHarness({
  ruleId = 'saved-rule',
  newDraft = false,
  response,
  fetchError,
  saveInProgress = false
} = {}) {
  const calls = { fetch: 0, load: 0, render: 0, update: 0, toasts: [] };
  const context = {
    calls,
    fetch: async () => {
      calls.fetch++;
      if (fetchError) throw fetchError;
      return response;
    }
  };
  vm.runInNewContext(`
    const API_BASE = 'http://api.test';
    const mockDraftRules = new Map([['${ruleId}', { title: 'unsaved draft' }]]);
    const mockExpandedRules = new Set(['${ruleId}']);
    const mockNewDraftIds = new Set(${newDraft ? `['${ruleId}']` : '[]'});
    let mockSaveInProgress = ${saveInProgress};
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    let mockReorderQueue = Promise.resolve();
    let mockEditingRule = '${ruleId}';
    let mockEditDraft = { title: 'live editor state' };
    let mockRules = [{ id: '${ruleId}', title: 'unsaved draft' }];
    function toast(message, type) { calls.toasts.push([message, type]); }
    function updateMockSaveButtons() { calls.update++; }
    function renderMockRules() { calls.render++; }
    async function loadMockRules() { calls.load++; }
    ${queueMockCollectionMutationSource}
    ${deleteMockRuleSource}
    globalThis.harness = {
      deleteMockRule,
      state() {
        return {
          draft: mockDraftRules.get('${ruleId}'),
          expanded: mockExpandedRules.has('${ruleId}'),
          newDraft: mockNewDraftIds.has('${ruleId}'),
          editingRule: mockEditingRule,
          editDraft: mockEditDraft,
          ruleCount: mockRules.length
        };
      }
    };
  `, context);
  return { harness: context.harness, calls };
}

function assertSavedEditorPreserved(state) {
  assert.equal(state.draft.title, 'unsaved draft');
  assert.equal(state.expanded, true);
  assert.equal(state.editingRule, 'saved-rule');
  assert.equal(state.editDraft.title, 'live editor state');
  assert.equal(state.ruleCount, 1);
}

function assertToasts(calls, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(calls.toasts)), expected);
}

function createGroupHarness({ response, fetchError } = {}) {
  const calls = { fetch: 0, load: 0, update: 0, toasts: [] };
  const context = {
    calls,
    confirm: () => true,
    fetch: async () => {
      calls.fetch++;
      if (fetchError) throw fetchError;
      return response;
    }
  };
  vm.runInNewContext(`
    const API_BASE = 'http://api.test';
    const mockDraftRules = new Map([
      ['group-id', { title: 'group draft' }],
      ['child-edit', { title: 'edited child draft' }],
      ['child-new', { title: 'new child draft' }],
      ['unrelated', { title: 'unrelated draft' }]
    ]);
    const mockExpandedRules = new Set(['group-id', 'child-edit', 'child-new', 'unrelated']);
    const mockNewDraftIds = new Set(['child-new', 'unrelated']);
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    let mockReorderQueue = Promise.resolve();
    let breakpointRulesLoadGeneration = 0;
    let mockEditingRule = 'child-edit';
    let mockEditDraft = { title: 'live child editor' };
    let mockEditDirty = true;
    let mockRenamingRuleId = 'child-new';
    let mockRules = [{
      id: 'group-id', type: 'group', title: 'Saved group',
      items: [{ id: 'child-edit' }, { id: 'child-new' }]
    }, { id: 'unrelated', type: 'fixed-response' }];
    function toast(message, type) { calls.toasts.push([message, type]); }
    function updateMockSaveButtons() { calls.update++; }
    async function loadMockRules() { calls.load++; }
    ${queueMockCollectionMutationSource}
    ${deleteMockGroupSource}
    globalThis.harness = {
      deleteMockGroup,
      state() {
        return {
          draftIds: Array.from(mockDraftRules.keys()),
          expandedIds: Array.from(mockExpandedRules),
          newDraftIds: Array.from(mockNewDraftIds),
          editingRule: mockEditingRule,
          editDraft: mockEditDraft,
          editDirty: mockEditDirty,
          renamingRuleId: mockRenamingRuleId
        };
      }
    };
  `, context);
  return { harness: context.harness, calls };
}

test('failed saved-rule deletion preserves its draft, editor, and expansion state', async () => {
  const { harness, calls } = createHarness({
    response: {
      ok: false,
      status: 503,
      json: async () => ({ error: 'Rule store unavailable' })
    }
  });

  await harness.deleteMockRule('saved-rule');

  assertSavedEditorPreserved(harness.state());
  assertToasts(calls, [['Error: Rule store unavailable', 'error']]);
  assert.deepEqual(
    { fetch: calls.fetch, load: calls.load, render: calls.render, update: calls.update },
    { fetch: 1, load: 0, render: 0, update: 2 }
  );
});

test('an error payload on an OK deletion response also preserves local edits', async () => {
  const { harness, calls } = createHarness({
    response: {
      ok: true,
      status: 200,
      json: async () => ({ error: 'Deletion was rejected' })
    }
  });

  await harness.deleteMockRule('saved-rule');

  assertSavedEditorPreserved(harness.state());
  assertToasts(calls, [['Error: Deletion was rejected', 'error']]);
});

test('successful saved-rule deletion clears local state after server confirmation', async () => {
  const { harness, calls } = createHarness({
    response: {
      ok: true,
      status: 200,
      json: async () => ({ success: true })
    }
  });

  await harness.deleteMockRule('saved-rule');

  const state = harness.state();
  assert.equal(state.draft, undefined);
  assert.equal(state.expanded, false);
  assert.equal(state.editingRule, null);
  assert.equal(state.editDraft, null);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.update, 3);
  assert.equal(calls.load, 1);
  assertToasts(calls, [['Rule deleted', 'success']]);
});

test('a brand-new unsaved draft still deletes locally without an API request', async () => {
  const { harness, calls } = createHarness({
    newDraft: true,
    fetchError: new Error('fetch must not run for a new draft')
  });

  await harness.deleteMockRule('saved-rule');

  const state = harness.state();
  assert.equal(state.draft, undefined);
  assert.equal(state.expanded, false);
  assert.equal(state.newDraft, false);
  assert.equal(state.editingRule, null);
  assert.equal(state.editDraft, null);
  assert.equal(state.ruleCount, 0);
  assert.deepEqual(
    { fetch: calls.fetch, load: calls.load, render: calls.render, update: calls.update },
    { fetch: 0, load: 0, render: 1, update: 1 }
  );
  assertToasts(calls, [['Draft rule deleted', 'success']]);
});

test('deletion is blocked while a server save owns the draft snapshot', async () => {
  const { harness, calls } = createHarness({
    saveInProgress: true,
    fetchError: new Error('fetch must not run while saving')
  });

  await harness.deleteMockRule('saved-rule');

  assertSavedEditorPreserved(harness.state());
  assert.deepEqual(
    { fetch: calls.fetch, load: calls.load, render: calls.render, update: calls.update },
    { fetch: 0, load: 0, render: 0, update: 0 }
  );
  assertToasts(calls, []);
});

test('successful group deletion clears group and child drafts only after confirmation', async () => {
  const { harness, calls } = createGroupHarness({
    response: {
      ok: true,
      status: 200,
      json: async () => ({ success: true })
    }
  });

  await harness.deleteMockGroup('group-id');

  assert.deepEqual(JSON.parse(JSON.stringify(harness.state())), {
    draftIds: ['unrelated'],
    expandedIds: ['unrelated'],
    newDraftIds: ['unrelated'],
    editingRule: null,
    editDraft: null,
    editDirty: false,
    renamingRuleId: null
  });
  assert.deepEqual(
    { fetch: calls.fetch, load: calls.load, update: calls.update },
    { fetch: 1, load: 1, update: 3 }
  );
  assertToasts(calls, [['Group deleted', 'success']]);
});

test('failed group deletion preserves every draft and editor state', async t => {
  const scenarios = [
    {
      name: 'HTTP failure',
      response: { ok: false, status: 503, json: async () => ({ error: 'store unavailable' }) },
      message: 'Error: store unavailable'
    },
    {
      name: 'error payload',
      response: { ok: true, status: 200, json: async () => ({ error: 'deletion rejected' }) },
      message: 'Error: deletion rejected'
    },
    {
      name: 'fetch rejection',
      fetchError: new Error('network offline'),
      message: 'Error: network offline'
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { harness, calls } = createGroupHarness(scenario);
      const before = JSON.parse(JSON.stringify(harness.state()));

      await harness.deleteMockGroup('group-id');

      assert.deepEqual(JSON.parse(JSON.stringify(harness.state())), before);
      assert.equal(calls.fetch, 1);
      assert.equal(calls.load, 0);
      assert.equal(calls.update, 2);
      assertToasts(calls, [[scenario.message, 'error']]);
    });
  }
});

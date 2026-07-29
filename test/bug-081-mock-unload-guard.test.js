import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { PREPARE_RENDERER_FOR_QUIT_SCRIPT } from '../electron/quit-cleanup.cjs';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const guardStart = source.indexOf('function mockRuleDraftComparable(');
const guardEnd = source.indexOf('function isMockMatcherComplete(', guardStart);
assert.notEqual(guardStart, -1);
assert.notEqual(guardEnd, -1);
const guardSource = source.slice(guardStart, guardEnd);
const saveAllStart = source.indexOf('async function saveAllMockRules()');
const saveAllEnd = source.indexOf('async function saveOneMockRule(', saveAllStart);
assert.notEqual(saveAllStart, -1);
assert.notEqual(saveAllEnd, -1);
const saveAllSource = source.slice(saveAllStart, saveAllEnd);

const baseRule = {
  id: 'saved',
  enabled: true,
  priority: 'normal',
  matchers: [{ type: 'path', value: '/' }],
  preSteps: [],
  action: { type: 'fixed-response', body: 'original' },
  title: 'Saved rule'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createGuardHarness({
  drafts = [],
  editingRule = null,
  editDraft = null,
  originalRule = baseRule,
  renamingRuleId = null,
  renameValue,
  confirmResult = true,
  sendPrepared = true
} = {}) {
  let confirmCalls = 0;
  let persistenceCalls = 0;
  const context = {
    __drafts: drafts,
    __editingRule: editingRule,
    __editDraft: editDraft,
    __originalRule: originalRule,
    __renamingRuleId: renamingRuleId,
    document: {
      getElementById(id) {
        return id === 'mock-rename-input' && renameValue !== undefined
          ? { value: renameValue }
          : null;
      }
    },
    confirm() {
      confirmCalls++;
      return confirmResult;
    },
    persistActiveSendTabBeforeUnload() {
      persistenceCalls++;
      return sendPrepared;
    },
    normalizeMockRule: rule => clone(rule),
    _findMockRuleDeep: id => id === originalRule?.id ? originalRule : null
  };
  vm.createContext(context);
  vm.runInContext(`
    const mockDraftRules = new Map(globalThis.__drafts);
    let mockEditingRule = globalThis.__editingRule;
    let mockEditDraft = globalThis.__editDraft;
    let mockEditDirty = false;
    let mockRenamingRuleId = globalThis.__renamingRuleId;
    ${guardSource}
    globalThis.guardApi = {
      hasOpenChanges: hasOpenMockEditChanges,
      hasOpenRenameChanges: hasOpenMockRenameChanges,
      hasUnsavedWork: hasUnsavedMockWork,
      markDirty: markOpenMockEditDirty,
      setEditDraft: value => { mockEditDraft = value; },
      unload: guardUnsavedMockChangesBeforeUnload,
      prepareQuit: prepareRendererForQuit
    };
  `, context);
  return {
    api: context.guardApi,
    get confirmCalls() { return confirmCalls; },
    get persistenceCalls() { return persistenceCalls; }
  };
}

test('staged drafts and new editors are protected from unload', () => {
  const staged = createGuardHarness({ drafts: [['saved', clone(baseRule)]] });
  const newEditor = createGuardHarness({
    editingRule: '__new__',
    editDraft: clone(baseRule)
  });

  assert.equal(staged.api.hasUnsavedWork(), true);
  assert.equal(newEditor.api.hasOpenChanges(), true);
  assert.equal(newEditor.api.hasUnsavedWork(), true);
});

test('only a genuinely changed existing editor is treated as unsaved work', () => {
  const unchanged = createGuardHarness({
    editingRule: 'saved',
    editDraft: clone(baseRule)
  });
  const changedRule = clone(baseRule);
  changedRule.action.body = 'edited';
  const changed = createGuardHarness({ editingRule: 'saved', editDraft: changedRule });

  assert.equal(unchanged.api.hasOpenChanges(), false);
  assert.equal(unchanged.api.hasUnsavedWork(), false);
  assert.equal(changed.api.hasOpenChanges(), true);
  assert.equal(changed.api.hasUnsavedWork(), true);
});

test('a reopened staged draft is compared with its live editor state', () => {
  const stagedRule = clone(baseRule);
  stagedRule.action.body = 'staged';
  const unchanged = createGuardHarness({
    drafts: [['saved', stagedRule]],
    editingRule: 'saved',
    editDraft: clone(stagedRule)
  });
  const liveEdit = clone(stagedRule);
  liveEdit.action.body = 'newer live edit';
  const changed = createGuardHarness({
    drafts: [['saved', stagedRule]],
    editingRule: 'saved',
    editDraft: liveEdit
  });

  assert.equal(unchanged.api.hasOpenChanges(), false);
  assert.equal(changed.api.hasOpenChanges(), true);
});

test('focused editor input is dirty before its change handler updates the draft model', () => {
  const renderer = createGuardHarness({
    editingRule: 'saved',
    editDraft: clone(baseRule)
  });
  const editor = { id: 'mockEditor_saved' };

  renderer.api.markDirty({ type: 'input', target: { closest: () => editor } });

  assert.equal(renderer.api.hasOpenChanges(), true);
  assert.equal(renderer.api.hasUnsavedWork(), true);
});

test('committing a reverted input clears the transient dirty marker', () => {
  const renderer = createGuardHarness({
    editingRule: 'saved',
    editDraft: clone(baseRule)
  });
  const editor = { id: 'mockEditor_saved' };

  renderer.api.markDirty({ type: 'input', target: { closest: () => editor } });
  assert.equal(renderer.api.hasOpenChanges(), true);
  renderer.api.setEditDraft(clone(baseRule));
  renderer.api.markDirty({ type: 'change', target: { closest: () => editor } });

  assert.equal(renderer.api.hasOpenChanges(), false);
  assert.equal(renderer.api.hasUnsavedWork(), false);
});

test('focused inline rename text is protected before blur', () => {
  const changed = createGuardHarness({
    renamingRuleId: 'saved',
    renameValue: 'A better name'
  });
  const unchanged = createGuardHarness({
    renamingRuleId: 'saved',
    renameValue: `  ${baseRule.title}  `
  });

  assert.equal(changed.api.hasOpenRenameChanges(), true);
  assert.equal(changed.api.hasUnsavedWork(), true);
  assert.equal(unchanged.api.hasOpenRenameChanges(), false);
  assert.equal(unchanged.api.hasUnsavedWork(), false);
});

function createSaveAllHarness({ stageResult = true } = {}) {
  const olderDraft = clone(baseRule);
  olderDraft.id = 'older';
  const liveDraft = clone(baseRule);
  liveDraft.id = 'live';
  liveDraft.action.body = 'newer live edit';
  const requests = [];
  const context = {
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    },
    __olderDraft: olderDraft,
    __liveDraft: liveDraft
  };
  vm.createContext(context);
  vm.runInContext(`
    const API_BASE = '';
    const mockDraftRules = new Map([['older', globalThis.__olderDraft]]);
    const mockNewDraftIds = new Set();
    let mockEditingRule = 'live';
    let mockEditDraft = globalThis.__liveDraft;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    function hasOpenMockEditChanges() { return true; }
    function hasUnsavedMockChanges() { return mockDraftRules.size > 0; }
    function saveMockRule(ruleId) {
      globalThis.stageCalls++;
      if (!globalThis.stageResult) return false;
      mockDraftRules.set(ruleId, mockEditDraft);
      mockEditingRule = null;
      mockEditDraft = null;
      return true;
    }
    function updateMockSaveButtons() {}
    function toast() {}
    async function loadMockRules() {}
    globalThis.stageResult = ${stageResult};
    globalThis.stageCalls = 0;
    ${saveAllSource}
    globalThis.saveAll = saveAllMockRules;
    globalThis.remainingDrafts = () => Array.from(mockDraftRules.keys());
  `, context);
  return {
    saveAll: context.saveAll,
    remainingDrafts: context.remainingDrafts,
    requests,
    get stageCalls() { return context.stageCalls; }
  };
}

test('Save All stages the live editor before taking its upload snapshot', async () => {
  const harness = createSaveAllHarness();

  await harness.saveAll();

  assert.equal(harness.stageCalls, 1);
  assert.deepEqual(harness.requests.map(request => request.url), [
    '/api/mock-rules/older',
    '/api/mock-rules/live'
  ]);
  assert.equal(harness.requests[1].body.action.body, 'newer live edit');
  assert.deepEqual([...harness.remainingDrafts()], []);
});

test('Save All aborts without uploading older drafts when the live editor is invalid', async () => {
  const harness = createSaveAllHarness({ stageResult: false });

  await harness.saveAll();

  assert.equal(harness.stageCalls, 1);
  assert.deepEqual(harness.requests, []);
  assert.deepEqual([...harness.remainingDrafts()], ['older']);
});

test('the beforeunload guard blocks unsaved work and leaves clean navigation alone', () => {
  const dirty = createGuardHarness({ drafts: [['saved', clone(baseRule)]] });
  let prevented = false;
  const event = {
    returnValue: undefined,
    preventDefault() { prevented = true; }
  };

  assert.equal(dirty.api.unload(event), false);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');

  const clean = createGuardHarness();
  assert.equal(clean.api.unload(event), true);
});

test('Electron quit confirms mock work before running Send persistence', () => {
  const canceled = createGuardHarness({
    drafts: [['saved', clone(baseRule)]],
    confirmResult: false
  });
  assert.equal(canceled.api.prepareQuit(), false);
  assert.equal(canceled.confirmCalls, 1);
  assert.equal(canceled.persistenceCalls, 0);

  const accepted = createGuardHarness({
    drafts: [['saved', clone(baseRule)]],
    confirmResult: true,
    sendPrepared: true
  });
  assert.equal(accepted.api.prepareQuit(), true);
  assert.equal(accepted.confirmCalls, 1);
  assert.equal(accepted.persistenceCalls, 1);

  const sendFailure = createGuardHarness({ sendPrepared: false });
  assert.equal(sendFailure.api.prepareQuit(), false);
  assert.equal(sendFailure.confirmCalls, 0);
  assert.equal(sendFailure.persistenceCalls, 1);
});

test('renderer registers the mock unload guard and exposes the combined quit preflight', () => {
  assert.match(
    source,
    /window\.addEventListener\('beforeunload', guardUnsavedMockChangesBeforeUnload\)/
  );
  assert.match(source, /document\.addEventListener\('input', markOpenMockEditDirty\)/);
  assert.match(source, /window\.prepareRendererForQuit = prepareRendererForQuit/);
  assert.match(PREPARE_RENDERER_FOR_QUIT_SCRIPT, /prepareRendererForQuit/);
  assert.match(PREPARE_RENDERER_FOR_QUIT_SCRIPT, /prepareSendTabPersistenceForQuit/);
});

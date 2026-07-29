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
    ${guardSource}
    globalThis.guardApi = {
      hasOpenChanges: hasOpenMockEditChanges,
      hasUnsavedWork: hasUnsavedMockWork,
      markDirty: markOpenMockEditDirty,
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

test('focused editor input is dirty before its change handler updates the draft model', () => {
  const renderer = createGuardHarness({
    editingRule: 'saved',
    editDraft: clone(baseRule)
  });
  const editor = { id: 'mockEditor_saved' };

  renderer.api.markDirty({ target: { closest: () => editor } });

  assert.equal(renderer.api.hasOpenChanges(), true);
  assert.equal(renderer.api.hasUnsavedWork(), true);
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

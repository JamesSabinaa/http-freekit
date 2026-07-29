import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

const editorSource = section('function preserveOpenMockEdit', 'function toggleMockRuleEnabled');
const saveSource = section('function isMockMatcherComplete', '/** Apply a draft');
const collapseAllSource = section('function collapseAllMockRules', 'function mockDragStart');
const toggleGroupSource = section('function toggleMockGroup(groupId)', 'function toggleMockGroupEnabled');
const moveToGroupSource = section('function moveRuleToGroup(ruleId, groupId)', 'async function ungroupRule');

function createEditorHarness({
  valid = false,
  expanded = ['A'],
  grouped = false,
  collapsedTarget = false
} = {}) {
  const calls = { fetches: 0, renders: 0, toasts: [] };
  const context = { calls };
  vm.runInNewContext(`
    const baseAction = { type: 'fixed-response', status: 200, headers: {}, body: '' };
    const ruleA = {
        id: 'A', enabled: true, priority: 'normal',
        matchers: [{ type: 'path', value: '/original', matchType: 'prefix' }],
        preSteps: [], action: baseAction
      };
    const ruleB = {
        id: 'B', enabled: true, priority: 'normal',
        matchers: [{ type: 'path', value: '/second', matchType: 'prefix' }],
        preSteps: [], action: baseAction
      };
    let mockRules = ${grouped
      ? `[
          { id: 'group-A', type: 'group', collapsed: false, items: [ruleA] },
          { id: 'group-B', type: 'group', collapsed: ${collapsedTarget}, items: [ruleB] }
        ]`
      : '[ruleA, ruleB]'};
    const mockDraftRules = new Map();
    const mockNewDraftIds = new Set();
    const mockExpandedRules = new Set(${JSON.stringify(expanded)});
    let mockEditingRule = 'A';
    let mockEditDraft = {
      enabled: true,
      priority: 'normal',
      matchers: [{
        type: 'path',
        value: ${JSON.stringify(valid ? '/changed' : '')},
        matchType: 'prefix'
      }],
      preSteps: [],
      action: baseAction
    };
    let mockEditDirty = true;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;
    let mockCollectionMutationCount = 0;
    const API_BASE = 'http://api.test';
    function toast(message, type) { calls.toasts.push({ message, type }); }
    function renderMockRules() { calls.renders++; }
    function updateMockSaveButtons() {}
    function _queueMockCollectionMutation(mutation) { return mutation(); }
    async function fetch() {
      calls.fetches++;
      return { ok: true, json: async () => ({ success: true }) };
    }
    async function loadMockRules() {}
    function _findMockRuleDeep(ruleId) {
      for (const item of mockRules) {
        if (item.id === ruleId) return item;
        const nested = item.type === 'group' && item.items?.find(rule => rule.id === ruleId);
        if (nested) return nested;
      }
      return null;
    }
    function normalizeMockRule(rule) { return JSON.parse(JSON.stringify(rule)); }
    function _applyDraftToLocal(ruleId, draft) {
      const rule = _findMockRuleDeep(ruleId);
      if (rule) Object.assign(rule, draft);
    }
    const document = { getElementById: () => null };
    function setTimeout() {}
    ${collapseAllSource}
    ${editorSource}
    ${saveSource}
    ${toggleGroupSource}
    ${moveToGroupSource}
    globalThis.harness = {
      collapseAllMockRules,
      moveRuleToGroup,
      toggleMockGroup,
      toggleMockRuleExpand,
      state: () => ({
        draftCount: mockDraftRules.size,
        editingRule: mockEditingRule,
        expanded: Array.from(mockExpandedRules),
        groups: mockRules.filter(rule => rule.type === 'group')
          .map(group => [group.id, group.collapsed]),
        hasEditDraft: mockEditDraft !== null,
        savedPath: mockDraftRules.get('A')?.matchers?.[0]?.value || null
      })
    };
  `, context);
  return {
    calls,
    harness: {
      collapseAllMockRules: context.harness.collapseAllMockRules,
      moveRuleToGroup: context.harness.moveRuleToGroup,
      toggleMockGroup: context.harness.toggleMockGroup,
      toggleMockRuleExpand: context.harness.toggleMockRuleExpand,
      state: () => JSON.parse(JSON.stringify(context.harness.state()))
    }
  };
}

test('opening a mock editor first preserves the currently open edit', () => {
  const addSource = section('function addNewMockRule()', 'function editMockRule');
  const editSource = section('function editMockRule', 'function cancelMockEdit');

  assert.match(addSource, /if \(!preserveOpenMockEdit\('__new__'\)\) return/);
  assert.match(editSource, /if \(!preserveOpenMockEdit\(ruleId\)\) return/);
});

test('editor preservation saves valid drafts and blocks navigation on validation failure', () => {
  const preserveSource = section('function preserveOpenMockEdit', 'function addNewMockRule');
  const saveSource = section('function saveMockRule', 'function _applyDraftToLocal');

  assert.match(preserveSource, /return saveMockRule\(mockEditingRule\)/);
  assert.match(saveSource, /return false/);
  assert.match(saveSource, /return true/);
});

test('invalid edits block single-rule and Collapse All navigation without losing state', () => {
  const single = createEditorHarness();
  single.harness.toggleMockRuleExpand('A');
  assert.deepEqual(single.harness.state(), {
    draftCount: 0,
    editingRule: 'A',
    expanded: ['A'],
    groups: [],
    hasEditDraft: true,
    savedPath: null
  });

  const all = createEditorHarness({ expanded: ['A', 'B'] });
  all.harness.collapseAllMockRules();
  assert.deepEqual(all.harness.state(), {
    draftCount: 0,
    editingRule: 'A',
    expanded: ['A', 'B'],
    groups: [],
    hasEditDraft: true,
    savedPath: null
  });
  assert.equal(all.calls.toasts.at(-1)?.type, 'error');
});

test('invalid edits block expansion of another rule', () => {
  const editor = createEditorHarness();
  editor.harness.toggleMockRuleExpand('B');
  assert.deepEqual(editor.harness.state().expanded, ['A']);
  assert.equal(editor.harness.state().editingRule, 'A');
  assert.equal(editor.harness.state().hasEditDraft, true);
});

test('valid edits become drafts before single-rule and Collapse All navigation', () => {
  const single = createEditorHarness({ valid: true });
  single.harness.toggleMockRuleExpand('A');
  assert.deepEqual(single.harness.state(), {
    draftCount: 1,
    editingRule: null,
    expanded: [],
    groups: [],
    hasEditDraft: false,
    savedPath: '/changed'
  });

  const all = createEditorHarness({ valid: true, expanded: ['A', 'B'] });
  all.harness.collapseAllMockRules();
  assert.deepEqual(all.harness.state(), {
    draftCount: 1,
    editingRule: null,
    expanded: [],
    groups: [],
    hasEditDraft: false,
    savedPath: '/changed'
  });
});

test('containing-group collapse preserves valid nested edits and blocks invalid ones', () => {
  const invalid = createEditorHarness({ grouped: true });
  invalid.harness.toggleMockGroup('group-A');
  assert.equal(invalid.harness.state().editingRule, 'A');
  assert.equal(invalid.harness.state().draftCount, 0);
  assert.deepEqual(invalid.harness.state().groups, [
    ['group-A', false],
    ['group-B', false]
  ]);

  const valid = createEditorHarness({ grouped: true, valid: true });
  valid.harness.toggleMockGroup('group-A');
  assert.equal(valid.harness.state().editingRule, null);
  assert.equal(valid.harness.state().draftCount, 1);
  assert.equal(valid.harness.state().savedPath, '/changed');
  assert.deepEqual(valid.harness.state().groups, [
    ['group-A', true],
    ['group-B', false]
  ]);
});

test('collapsing an unrelated group leaves the nested active editor untouched', () => {
  const editor = createEditorHarness({ grouped: true });
  editor.harness.toggleMockGroup('group-B');
  assert.equal(editor.harness.state().editingRule, 'A');
  assert.equal(editor.harness.state().hasEditDraft, true);
  assert.equal(editor.harness.state().draftCount, 0);
  assert.deepEqual(editor.harness.state().groups, [
    ['group-A', false],
    ['group-B', true]
  ]);
});

test('moving the active editor into a collapsed group preserves or blocks it first', async () => {
  const invalid = createEditorHarness({ grouped: true, collapsedTarget: true });
  await invalid.harness.moveRuleToGroup('A', 'group-B');
  assert.equal(invalid.calls.fetches, 0);
  assert.equal(invalid.harness.state().editingRule, 'A');
  assert.equal(invalid.harness.state().hasEditDraft, true);
  assert.equal(invalid.harness.state().draftCount, 0);

  const valid = createEditorHarness({ grouped: true, collapsedTarget: true, valid: true });
  await valid.harness.moveRuleToGroup('A', 'group-B');
  assert.equal(valid.calls.fetches, 1);
  assert.equal(valid.harness.state().editingRule, null);
  assert.equal(valid.harness.state().draftCount, 1);
  assert.equal(valid.harness.state().savedPath, '/changed');
});

test('moving the active editor into an expanded group keeps the live edit open', async () => {
  const editor = createEditorHarness({ grouped: true });
  await editor.harness.moveRuleToGroup('A', 'group-B');
  assert.equal(editor.calls.fetches, 1);
  assert.equal(editor.harness.state().editingRule, 'A');
  assert.equal(editor.harness.state().hasEditDraft, true);
  assert.equal(editor.harness.state().draftCount, 0);
});

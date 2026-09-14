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

const editorSource = section('function preserveOpenMockEdit', 'function updateMockMatcher');
const saveSource = section('function isMockMatcherComplete', '/** Apply a draft');
const collapseAllSource = section('function collapseAllMockRules', 'function mockDragStart');
const toggleGroupSource = section('function toggleMockGroup(groupId)', 'function toggleMockGroupEnabled');
const moveToGroupSource = section('function moveRuleToGroup(ruleId, groupId)', 'async function ungroupRule');
const renameSource = section('function confirmInlineRename(', 'function cancelInlineRename(');

function createEditorHarness({
  valid = false,
  title,
  unchanged = false,
  enabled = true,
  expanded = ['A'],
  grouped = false,
  collapsedTarget = false
} = {}) {
  const calls = { fetches: 0, renders: 0, toasts: [] };
  const context = { calls };
  vm.runInNewContext(`
    const baseAction = { type: 'fixed-response', status: 200, headers: {}, body: '' };
    const ruleA = {
        title: ${JSON.stringify(title)},
        id: 'A', enabled: ${enabled}, priority: 'normal',
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
    let mockRenamingRuleId = null;
    let renameValue = '';
    let mockEditDraft = {
      title: ${JSON.stringify(title)},
      enabled: ${enabled},
      priority: 'normal',
      matchers: [{
        type: 'path',
        value: ${JSON.stringify(unchanged ? '/original' : valid ? '/changed' : '')},
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
    const document = { getElementById: id => id === 'mock-rename-input' ? { value: renameValue } : null };
    function setTimeout() {}
    ${collapseAllSource}
    ${editorSource}
    ${saveSource}
    ${toggleGroupSource}
    ${moveToGroupSource}
    ${renameSource}
    globalThis.harness = {
      rename(ruleId, value) {
        mockRenamingRuleId = ruleId;
        renameValue = value;
        confirmInlineRename(ruleId);
      },
      addNewMockRule,
      collapseAllMockRules,
      editMockRule,
      moveRuleToGroup,
      saveMockRule,
      toggleMockGroup,
      toggleMockRuleEnabled,
      toggleMockRuleExpand,
      drafts: () => Array.from(mockDraftRules.values()),
      isNewDraft: id => mockNewDraftIds.has(id),
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
      rename: context.harness.rename,
      addNewMockRule: context.harness.addNewMockRule,
      collapseAllMockRules: context.harness.collapseAllMockRules,
      editMockRule: context.harness.editMockRule,
      moveRuleToGroup: context.harness.moveRuleToGroup,
      saveMockRule: context.harness.saveMockRule,
      toggleMockGroup: context.harness.toggleMockGroup,
      toggleMockRuleEnabled: context.harness.toggleMockRuleEnabled,
      toggleMockRuleExpand: context.harness.toggleMockRuleExpand,
      drafts: () => JSON.parse(JSON.stringify(context.harness.drafts())),
      isNewDraft: context.harness.isNewDraft,
      state: () => JSON.parse(JSON.stringify(context.harness.state()))
    }
  };
}

for (const title of ['New title', '']) {
  test(`saving an edited rule preserves its inline ${title ? 'rename' : 'title removal'}`, () => {
    const { harness } = createEditorHarness({ valid: true, title: 'Original title' });
    harness.rename('A', title);
    assert.equal(harness.saveMockRule('A'), true);
    const draft = harness.drafts().find(rule => rule.id === 'A');
    assert.equal(draft.title, title || undefined);
    assert.equal(draft.matchers[0].value, '/changed');
  });
}

test('renaming another rule does not change the open editor title', () => {
  const { harness } = createEditorHarness({ valid: true, title: 'Original title' });
  harness.rename('B', 'Other title');
  assert.equal(harness.saveMockRule('A'), true);
  assert.equal(harness.drafts().find(rule => rule.id === 'A').title, 'Original title');
  assert.equal(harness.drafts().find(rule => rule.id === 'B').title, 'Other title');
});

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

test('saving an unchanged grouped rule does not create a false draft', () => {
  const editor = createEditorHarness({ grouped: true, unchanged: true });

  assert.equal(editor.harness.saveMockRule('A'), true);
  assert.deepEqual(editor.harness.state(), {
    draftCount: 0,
    editingRule: null,
    expanded: ['A'],
    groups: [
      ['group-A', false],
      ['group-B', false]
    ],
    hasEditDraft: false,
    savedPath: null
  });
  assert.deepEqual(JSON.parse(JSON.stringify(editor.calls.toasts.at(-1))), {
    message: 'No changes to save',
    type: 'success'
  });
});

for (const grouped of [false, true]) {
  test(`reopening and collapsing a ${grouped ? 'grouped' : 'top-level'} draft preserves unsaved changes`, () => {
    const editor = createEditorHarness({ grouped, valid: true });
    assert.equal(editor.harness.saveMockRule('A'), true);
    const savedDraft = editor.harness.drafts()[0];

    editor.harness.editMockRule('A');
    editor.harness.toggleMockRuleExpand('A');

    assert.deepEqual(editor.harness.drafts(), [savedDraft]);
    assert.equal(editor.harness.state().editingRule, null);
    assert.equal(editor.harness.state().savedPath, '/changed');
  });
}

test('switching editors preserves an existing pending draft even without further edits', () => {
  const editor = createEditorHarness({ valid: true });
  editor.harness.saveMockRule('A');
  const savedDraft = editor.harness.drafts()[0];

  editor.harness.editMockRule('A');
  editor.harness.editMockRule('B');

  assert.deepEqual(editor.harness.drafts(), [savedDraft]);
  assert.equal(editor.harness.state().editingRule, 'B');
});

test('reopening and saving a new rule keeps it eligible for its first server save', () => {
  const editor = createEditorHarness({ unchanged: true });
  editor.harness.addNewMockRule();
  assert.equal(editor.harness.saveMockRule('__new__'), true);
  const savedDraft = editor.harness.drafts()[0];
  assert.equal(editor.harness.isNewDraft(savedDraft.id), true);

  editor.harness.editMockRule(savedDraft.id);
  assert.equal(editor.harness.saveMockRule(savedDraft.id), true);

  assert.deepEqual(editor.harness.drafts(), [savedDraft]);
  assert.equal(editor.harness.isNewDraft(savedDraft.id), true);
});

for (const enabled of [true, false]) {
  test(`${enabled ? 'disabling' : 'enabling'} an open rule survives saving its other edits`, () => {
    const editor = createEditorHarness({ valid: true, enabled });

    editor.harness.toggleMockRuleEnabled('A');
    assert.equal(editor.harness.state().editingRule, 'A');
    assert.equal(editor.harness.saveMockRule('A'), true);

    const savedDraft = editor.harness.drafts()[0];
    assert.equal(savedDraft.enabled, !enabled);
    assert.equal(savedDraft.matchers[0].value, '/changed');
  });
}

test('toggling a different rule leaves the active editor enabled state alone', () => {
  const editor = createEditorHarness({ valid: true });

  editor.harness.toggleMockRuleEnabled('B');
  editor.harness.saveMockRule('A');

  const drafts = editor.harness.drafts();
  assert.equal(drafts.find(rule => rule.id === 'A').enabled, true);
  assert.equal(drafts.find(rule => rule.id === 'B').enabled, false);
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'styles.css'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = rendererSource.indexOf(start);
  const endIndex = rendererSource.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `${start} must precede ${end}`);
  return rendererSource.slice(startIndex, endIndex);
}

const containingGroupSource = sourceBetween(
  'function _findContainingMockGroup',
  'async function clearAllMockRules'
);
const groupDragSource = sourceBetween(
  'function mockGroupDragOver',
  'function _replaceMockRulesFromServer'
);
const renderRuleSource = sourceBetween(
  'function renderMockRuleRow',
  'function renderMockGroup'
);
const renderGroupSource = sourceBetween(
  'function renderMockGroup',
  'function _countAllMockRules'
);

function classListRecorder() {
  const classes = new Set();
  return {
    classes,
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
  };
}

function dragEvent(currentTarget, { overRule = false } = {}) {
  let prevented = 0;
  let stopped = 0;
  return {
    currentTarget,
    target: { closest: () => overRule ? {} : null },
    dataTransfer: { dropEffect: 'none' },
    preventDefault: () => { prevented++; },
    stopPropagation: () => { stopped++; },
    get prevented() { return prevented; },
    get stopped() { return stopped; }
  };
}

test('mock groups accept drops from top-level rules and other groups', async () => {
  const moves = [];
  const cleaned = { classList: classListRecorder() };
  const groupTarget = { classList: classListRecorder() };
  const context = {
    document: { querySelectorAll: () => [groupTarget, cleaned] },
    moveRuleToGroup: async (ruleId, groupId) => { moves.push({ ruleId, groupId }); }
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockRules = [
      { id: 'top-level' },
      { id: 'group-a', type: 'group', items: [{ id: 'nested' }] },
      { id: 'group-b', type: 'group', items: [] }
    ];
    let mockDragId = null;
    let mockResetInProgress = false;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    ${containingGroupSource}
    ${groupDragSource}
    globalThis.beginDrag = ruleId => { mockDragId = ruleId; };
    globalThis.dragOverGroup = (event, groupId) => mockGroupDragOver(event, groupId);
    globalThis.dropOnGroup = (event, groupId) => mockGroupDrop(event, groupId);
  `, context);

  context.beginDrag('top-level');
  const over = dragEvent(groupTarget);
  context.dragOverGroup(over, 'group-a');
  assert.equal(over.prevented, 1);
  assert.equal(over.stopped, 1);
  assert.equal(over.dataTransfer.dropEffect, 'move');
  assert.equal(groupTarget.classList.classes.has('mock-drag-over'), true);

  const firstDrop = dragEvent(groupTarget);
  await context.dropOnGroup(firstDrop, 'group-a');
  assert.deepEqual(moves, [{ ruleId: 'top-level', groupId: 'group-a' }]);
  assert.equal(firstDrop.prevented, 1);
  assert.equal(firstDrop.stopped, 1);

  context.beginDrag('nested');
  await context.dropOnGroup(dragEvent(groupTarget), 'group-b');
  assert.deepEqual(moves.at(-1), { ruleId: 'nested', groupId: 'group-b' });
});

test('group drops do not replace rule reordering or move within the same group', async () => {
  const moves = [];
  const context = {
    document: { querySelectorAll: () => [] },
    moveRuleToGroup: async (ruleId, groupId) => { moves.push({ ruleId, groupId }); }
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockRules = [{ id: 'group-a', type: 'group', items: [{ id: 'nested' }] }];
    let mockDragId = null;
    let mockResetInProgress = false;
    let mockSaveInProgress = false;
    let mockRevertInProgress = false;
    ${containingGroupSource}
    ${groupDragSource}
    globalThis.beginDrag = ruleId => { mockDragId = ruleId; };
    globalThis.dropOnGroup = (event, groupId) => mockGroupDrop(event, groupId);
  `, context);

  context.beginDrag('nested');
  const sameGroup = dragEvent({ classList: classListRecorder() });
  await context.dropOnGroup(sameGroup, 'group-a');
  assert.equal(sameGroup.prevented, 0);

  context.beginDrag('nested');
  const ruleCard = dragEvent({ classList: classListRecorder() }, { overRule: true });
  await context.dropOnGroup(ruleCard, 'group-b');
  assert.equal(ruleCard.prevented, 0);
  assert.deepEqual(moves, []);
});

test('group markup exposes drop handling and grouped rules expose ungrouping', () => {
  const context = {
    MOCK_METHOD_COLORS: { '*': '#888' },
    esc: value => String(value),
    escapeHtmlAttribute: value => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'),
    mockDraftRules: new Map(),
    mockExpandedRules: new Set(),
    mockEditingRule: null,
    mockEditDraft: null,
    mockRenamingRuleId: null,
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockRules: [
      { id: 'top-level' },
      { id: 'target-group', type: 'group', collapsed: false, items: [{ id: 'nested' }] }
    ],
    normalizeMockRule: rule => rule,
    mockRuleSummary: () => ({ methodStr: 'ANY', matchStr: '*', actionStr: '', title: '' }),
    renderMockRuleDetail: () => '',
    renderMockRuleEditor: () => ''
  };
  vm.createContext(context);
  vm.runInContext(`
    ${containingGroupSource}
    ${renderRuleSource}
    ${renderGroupSource}
    globalThis.renderRule = renderMockRuleRow;
    globalThis.renderGroup = renderMockGroup;
  `, context);

  const groupedRule = context.renderRule({ id: 'nested' });
  const topLevelRule = context.renderRule({ id: 'top-level' });
  const hostileRule = context.renderRule({ id: 'x" onmouseover="alert(1)' });
  const emptyGroup = context.renderGroup({
    id: 'empty-group',
    type: 'group',
    collapsed: false,
    items: []
  });

  assert.match(groupedRule, /onclick="ungroupRule\(this\.closest\('\.mock-rule-card'\)\.dataset\.ruleId\)"/);
  assert.match(groupedRule, /data-rule-id="nested"/);
  assert.match(groupedRule, /aria-label="Move rule to top level"/);
  assert.doesNotMatch(topLevelRule, /ungroupRule/);
  assert.match(hostileRule, /data-rule-id="x&quot; onmouseover=&quot;alert\(1\)"/);
  assert.doesNotMatch(hostileRule, /data-rule-id="x" onmouseover=/);
  assert.match(emptyGroup, /data-group-id="empty-group"/);
  assert.match(emptyGroup, /ondragover="mockGroupDragOver\(event, this\.dataset\.groupId\)"/);
  assert.match(emptyGroup, /ondrop="mockGroupDrop\(event, this\.dataset\.groupId\)"/);
  assert.match(emptyGroup, /Drag a rule here/);
  assert.match(stylesSource, /\.mock-group\.mock-drag-over\s*\{/);
});

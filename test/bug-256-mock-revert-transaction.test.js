import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const responseStart = rendererSource.indexOf('async function _readMockRulesResponse(');
const responseEnd = rendererSource.indexOf('async function _reloadMockRulesAfterRejectedReorder(', responseStart);
const unsavedStart = rendererSource.indexOf('function hasUnsavedMockChanges()');
const unsavedEnd = rendererSource.indexOf('function isMockMatcherComplete(', unsavedStart);
const revertStart = rendererSource.indexOf('function _mockRevertStateToken()');
const revertEnd = rendererSource.indexOf('async function deleteMockRule(', revertStart);
assert.notEqual(responseStart, -1);
assert.notEqual(responseEnd, -1);
assert.notEqual(unsavedStart, -1);
assert.notEqual(unsavedEnd, -1);
assert.notEqual(revertStart, -1);
assert.notEqual(revertEnd, -1);

function rendererResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createRenderer(fetch, { rejectMalformedRules = false } = {}) {
  const elements = {
    mockSaveAllBtn: { style: { display: 'sentinel' }, disabled: false },
    mockRevertBtn: { style: { display: 'sentinel' }, disabled: false },
    mockUnsavedBadge: { style: { display: 'sentinel' }, textContent: '' }
  };
  const toasts = [];
  const context = {
    API_BASE: '',
    fetch,
    rejectMalformedRules,
    document: { getElementById: id => elements[id] || null },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockRules = [
      { id: 'saved', title: 'Draft-applied saved rule', action: { body: 'draft body' } },
      { id: '__draft_new', title: 'Unsaved new rule', action: { body: 'new body' } }
    ];
    const mockDraftRules = new Map([
      ['saved', { id: 'saved', title: 'Draft-applied saved rule', action: { body: 'draft body' } }],
      ['__draft_new', { id: '__draft_new', title: 'Unsaved new rule', action: { body: 'new body' } }]
    ]);
    const mockNewDraftIds = new Set(['__draft_new']);
    let mockEditingRule = 'saved';
    let mockEditDraft = { id: 'saved', title: 'Live editor', action: { body: 'live body' } };
    let mockEditDirty = false;
    let mockWorkRevision = 0;
    let mockRenamingRuleId = 'saved';
    let mockRulesLoadGeneration = 3;
    let mockRevertInProgress = false;
    let mockSaveInProgress = false;
    let renderCalls = 0;
    function renderMockRules() {
      renderCalls++;
      if (rejectMalformedRules && mockRules.some(rule => rule === null)) {
        throw new Error('Malformed mock rule could not render');
      }
    }
    ${rendererSource.slice(responseStart, responseEnd)}
    ${rendererSource.slice(unsavedStart, unsavedEnd)}
    ${rendererSource.slice(revertStart, revertEnd)}
    globalThis.markFocusedEditDirty = function(value) {
      const control = { type: 'text', value, defaultValue: 'live body' };
      const editor = {
        id: 'mockEditor_saved',
        querySelectorAll: () => [control]
      };
      control.closest = () => editor;
      markOpenMockEditDirty({ type: 'input', target: control });
    };
  `, context);

  const state = () => JSON.parse(JSON.stringify(vm.runInContext(`({
    mockRules,
    drafts: Array.from(mockDraftRules.entries()),
    newDraftIds: Array.from(mockNewDraftIds),
    mockEditingRule,
    mockEditDraft,
    mockRenamingRuleId,
    mockRevertInProgress,
    renderCalls
  })`, context)));
  context.updateMockSaveButtons();
  return { context, elements, toasts, state };
}

function buttonState(renderer) {
  return {
    saveDisplay: renderer.elements.mockSaveAllBtn.style.display,
    saveDisabled: renderer.elements.mockSaveAllBtn.disabled,
    revertDisplay: renderer.elements.mockRevertBtn.style.display,
    revertDisabled: renderer.elements.mockRevertBtn.disabled,
    badgeDisplay: renderer.elements.mockUnsavedBadge.style.display,
    badgeText: renderer.elements.mockUnsavedBadge.textContent
  };
}

test('failed Revert GETs preserve every draft, local rule, editor, and control', async () => {
  const failures = [
    {
      name: 'network',
      fetch: async () => { throw new Error('network unavailable'); },
      message: 'Error reverting rules: network unavailable'
    },
    {
      name: 'non-OK',
      fetch: async () => rendererResponse({ error: 'reload denied' }, { ok: false, status: 503 }),
      message: 'Error reverting rules: reload denied'
    },
    {
      name: 'invalid payload',
      fetch: async () => rendererResponse({ rules: {} }),
      message: 'Error reverting rules: Reverting mock rules returned an invalid response'
    }
  ];

  for (const failure of failures) {
    const renderer = createRenderer(failure.fetch);
    const originalState = renderer.state();
    const originalButtons = buttonState(renderer);
    const reverting = renderer.context.revertMockRules();

    assert.equal(renderer.elements.mockSaveAllBtn.disabled, true, failure.name);
    assert.equal(renderer.elements.mockRevertBtn.disabled, true, failure.name);
    await reverting;

    assert.deepEqual(renderer.state(), originalState, failure.name);
    assert.deepEqual(buttonState(renderer), originalButtons, failure.name);
    assert.deepEqual(renderer.toasts, [{ message: failure.message, type: 'error' }], failure.name);
  }
});

test('a malformed authoritative rule rolls back a failed Revert commit', async () => {
  const renderer = createRenderer(
    async () => rendererResponse({ rules: [null] }),
    { rejectMalformedRules: true }
  );
  const originalState = renderer.state();
  const originalButtons = buttonState(renderer);

  await renderer.context.revertMockRules();

  const restoredState = renderer.state();
  assert.deepEqual(
    { ...restoredState, renderCalls: originalState.renderCalls },
    originalState
  );
  assert.equal(restoredState.renderCalls, 2);
  assert.deepEqual(buttonState(renderer), originalButtons);
  assert.deepEqual(renderer.toasts, [{
    message: 'Error reverting rules: Malformed mock rule could not render',
    type: 'error'
  }]);
});

test('successful Revert atomically discards ownership and renders authoritative rules once', async () => {
  const pending = deferred();
  let requestCount = 0;
  const authoritativeRules = [{ id: 'saved', title: 'Server rule', action: { body: 'server body' } }];
  const renderer = createRenderer(() => {
    requestCount++;
    return pending.promise;
  });

  const reverting = renderer.context.revertMockRules();
  const duplicate = renderer.context.revertMockRules();
  await duplicate;
  assert.equal(requestCount, 1);
  assert.equal(renderer.elements.mockSaveAllBtn.disabled, true);
  assert.equal(renderer.elements.mockRevertBtn.disabled, true);

  pending.resolve(rendererResponse({ rules: authoritativeRules }));
  await reverting;

  assert.deepEqual(renderer.state(), {
    mockRules: authoritativeRules,
    drafts: [],
    newDraftIds: [],
    mockEditingRule: null,
    mockEditDraft: null,
    mockRenamingRuleId: null,
    mockRevertInProgress: false,
    renderCalls: 1
  });
  assert.deepEqual(buttonState(renderer), {
    saveDisplay: 'none',
    saveDisabled: false,
    revertDisplay: 'none',
    revertDisabled: false,
    badgeDisplay: 'none',
    badgeText: '0 unsaved changes'
  });
  assert.deepEqual(renderer.toasts, [{
    message: 'All unsaved changes discarded',
    type: 'success'
  }]);
});

test('a Revert response cannot discard editor changes made while it was loading', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  const originalRules = renderer.state().mockRules;

  const reverting = renderer.context.revertMockRules();
  vm.runInContext(`mockEditDraft.action.body = 'newer live body'`, renderer.context);
  pending.resolve(rendererResponse({ rules: [{ id: 'saved', title: 'Server rule' }] }));
  await reverting;

  const state = renderer.state();
  assert.deepEqual(state.mockRules, originalRules);
  assert.equal(state.mockEditDraft.action.body, 'newer live body');
  assert.equal(state.drafts.length, 2);
  assert.equal(state.renderCalls, 0);
  assert.equal(renderer.elements.mockRevertBtn.style.display, '');
  assert.equal(renderer.elements.mockRevertBtn.disabled, false);
  assert.deepEqual(renderer.toasts, [{
    message: 'Error reverting rules: Mock rules changed while Revert was loading',
    type: 'error'
  }]);
});

test('a Revert response cannot discard focused input before its model handler commits', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  const originalState = renderer.state();

  const reverting = renderer.context.revertMockRules();
  renderer.context.markFocusedEditDirty('newer focused body');
  pending.resolve(rendererResponse({ rules: [{ id: 'saved', title: 'Server rule' }] }));
  await reverting;

  assert.deepEqual(renderer.state(), originalState);
  assert.deepEqual(renderer.toasts, [{
    message: 'Error reverting rules: Mock rules changed while Revert was loading',
    type: 'error'
  }]);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const saveFunctionsStart = source.indexOf('async function saveAllMockRules()');
const saveFunctionsEnd = source.indexOf('function _mockRevertStateToken()', saveFunctionsStart);
const saveFunctionsSource = source.slice(saveFunctionsStart, saveFunctionsEnd);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createSaveHarness() {
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
  assert.match(buttonsSource, /saveAllBtn\.disabled = mockSaveInProgress/);
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

test('per-rule save and delete controls follow the shared save lock', () => {
  const rowStart = source.indexOf('function renderMockRuleRow(rule)');
  const rowEnd = source.indexOf('function renderMockGroup(group)', rowStart);
  const rowSource = source.slice(rowStart, rowEnd);
  const buttonsStart = source.indexOf('function updateMockSaveButtons()');
  const buttonsEnd = source.indexOf('async function deleteMockRule', buttonsStart);
  const buttonsSource = source.slice(buttonsStart, buttonsEnd);

  assert.match(rowSource, /mock-save-server[\s\S]{0,300}serverMutationDisabledAttr/);
  assert.match(rowSource, /mock-rule-delete[\s\S]{0,300}serverMutationDisabledAttr/);
  assert.match(buttonsSource, /querySelectorAll\?\.\('\.mock-save-server, \.mock-rule-delete'\)/);
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

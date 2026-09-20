import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
}

function createEditor(action) {
  const container = { innerHTML: '' };
  const escape = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const context = vm.createContext({
    action: structuredClone(action),
    document: { getElementById: id => id === 'mockActionConfig_rule' ? container : null },
    esc: escape,
    escapeHtmlAttribute: escape,
    addGeneratedControlAccessibleNames: html => html,
    replaceGeneratedHtmlPreservingFocus: (element, html) => { element.innerHTML = html; },
    mockHeaderEditorRows: headers => Object.entries(headers).map(([name, value]) => ({ name, value })),
    toast() {},
    updateMockSaveButtons() {},
    renderMockRules() {},
    _findMockRuleDeep: () => null,
    _applyDraftToLocal() {}
  });
  vm.runInContext(`
    const MOCK_ACTION_TYPES = [
      { value: 'fixed-response', label: 'Fixed response' },
      { value: 'transform-request', label: 'Transform request' },
      { value: 'transform-response', label: 'Transform response' }
    ];
    let mockEditDraft = {
      action,
      matchers: [{ type: 'wildcard' }],
      _originalRequestBody: 'CAPTURED REQUEST',
      _originalResponseBody: 'CAPTURED RESPONSE'
    };
    let mockEditingRule = 'rule';
    const mockDraftRules = new Map();
    const mockSaveInProgress = false, mockRevertInProgress = false,
      mockResetInProgress = false, mockCollectionMutationCount = 0;
    ${section('function renderMockActionFields(', 'function preserveOpenMockEdit(')}
    ${section('function changeMockActionType(', 'function nextMockHeaderName(')}
    ${section('function rerenderMockActionConfig(', '// ============ SEND REQUEST')}
    ${section('function isMockMatcherComplete(', '/** Apply a draft')}
    globalThis.editor = {
      changeType: type => changeMockActionType(type, 'rule'),
      render: () => rerenderMockActionConfig('rule'),
      action: () => mockEditDraft.action,
      save() {
        if (!saveMockRule('rule')) throw new Error('Draft save failed');
        return mockDraftRules.get('rule');
      }
    };
  `, context);
  return {
    ...context.editor,
    change(property, value) {
      const handler = [...container.innerHTML.matchAll(/\bonchange="([^"]*)"/g)]
        .map(match => match[1])
        .find(code => code.startsWith(`mockEditDraft.action.${property}=`));
      assert.ok(handler, `rendered ${property} control exists`);
      context.value = value;
      vm.runInContext(`(function() { ${handler} }).call({ value });`, context);
    },
    bodyText(property) {
      const textarea = [...container.innerHTML.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)]
        .find(match => match[1].includes(`onchange="mockEditDraft.action.${property}=this.value"`));
      assert.ok(textarea, `rendered ${property} textarea exists`);
      return textarea[2];
    }
  };
}

for (const [property, value] of [
  ['urlMode', 'modify'],
  ['headersMode', 'update'],
  ['bodyMode', 'json-merge'],
  ['resStatusMode', 'replace'],
  ['resHeadersMode', 'replace'],
  ['resBodyMode', 'json-merge']
]) {
  test(`${property} rerender preserves edited and explicitly empty transform bodies through Save Draft`, () => {
    for (const [requestBody, responseBody] of [
      ['{"request":"edited café"}', ''],
      ['', '{"response":"edited café"}']
    ]) {
      const editor = createEditor({ type: 'fixed-response', status: 200, body: 'CAPTURED RESPONSE' });
      editor.changeType('transform-request');
      assert.equal(editor.action().body, 'CAPTURED REQUEST');
      assert.equal(editor.action().resBody, 'CAPTURED RESPONSE');
      editor.change('bodyMode', 'replace-fixed');
      editor.change('resBodyMode', 'replace-fixed');
      editor.change('body', requestBody);
      editor.change('resBody', responseBody);
      editor.change(property, value);

      assert.equal(editor.bodyText('body'), requestBody.replaceAll('"', '&quot;'));
      assert.equal(editor.bodyText('resBody'), responseBody.replaceAll('"', '&quot;'));
      const saved = editor.save();
      assert.equal(saved.action.body, requestBody);
      assert.equal(saved.action.resBody, responseBody);
      assert.equal(saved.action[property], value);
    }
  });
}

test('same-type selection preserves a fixed response draft instead of restoring captured body', () => {
  const editor = createEditor({ type: 'fixed-response', status: 202, body: 'INITIAL' });
  editor.render();
  editor.change('body', '');
  editor.changeType('fixed-response');
  assert.equal(editor.bodyText('body'), '');
  const saved = editor.save();
  assert.equal(saved.action.body, '');
  assert.equal(saved.action.status, 202);
});

test('legacy response migration and later rerenders keep response edits separate from request bodies', () => {
  for (const body of ['', 'LEGACY RESPONSE']) {
    const editor = createEditor({
      type: 'transform-response', bodyMode: 'replace-fixed', body,
      statusOverride: 203, headers: { 'X-Response': 'yes' }, delay: 17
    });
    editor.changeType('transform-request');
    editor.change('urlMode', 'modify');
    assert.equal(editor.bodyText('resBody'), body);
    const saved = editor.save();
    assert.equal(saved.action.bodyMode, 'original');
    assert.equal(saved.action.body, '');
    assert.equal(saved.action.resBodyMode, 'replace-fixed');
    assert.equal(saved.action.resBody, body);
    assert.equal(saved.action.resStatusOverride, 203);
    assert.equal(saved.action.resHeaders['X-Response'], 'yes');
    assert.equal(saved.action.delay, 17);
  }
});

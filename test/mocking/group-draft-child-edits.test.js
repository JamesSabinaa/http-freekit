import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

const source = fs.readFileSync('src/ui/app.js', 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('group property drafts preserve later child edits through either save path', async t => {
  for (const change of ['toggle', 'rename']) {
    for (const save of ['all', 'individual']) {
      await t.test(`${change} ${save}`, async t => {
        const proxy = new ProxyServer(null);
        proxy.mockRules = [{ id: 'group', type: 'group', title: 'Original', enabled: true, items: [{
          id: 'child', enabled: true, matchers: [{ type: 'method', value: 'GET' }],
          action: { type: 'fixed-response', status: 200, body: 'ORIGINAL' }
        }] }];
        const api = new ApiServer(proxy, null, null);
        const server = http.createServer(api.app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => server.close(resolve)));
        const context = { fetch, initialRules: structuredClone(proxy.mockRules), prompt: () => 'Renamed' };
        vm.runInNewContext(`
          const API_BASE = 'http://127.0.0.1:${server.address().port}';
          let mockRules = initialRules;
          const mockDraftRules = new Map();
          const mockNewDraftIds = new Set();
          let mockSaveInProgress = false, mockRevertInProgress = false, mockResetInProgress = false;
          let mockCollectionMutationCount = 0, mockEditingRule = null, mockEditDraft = null;
          function updateMockSaveButtons() {}
          function renderMockRules() {}
          function toast(message, type) { if (type === 'error') throw new Error(message); }
          function hasOpenMockEditChanges() { return false; }
          function hasUnsavedMockChanges() { return mockDraftRules.size > 0; }
          async function loadMockRules() {
            const response = await fetch(API_BASE + '/api/mock-rules');
            _replaceMockRulesFromServer((await response.json()).rules);
          }
          ${section('function _replaceMockRulesFromServer(', 'function _restoreMockRuleOrder(')}
          ${section('function _applyDraftToLocal(', 'function _mockRevertStateToken(')}
          ${section('function toggleMockGroupEnabled(', 'async function deleteMockGroup(')}
          function editChild(body) {
            const child = JSON.parse(JSON.stringify(mockRules[0].items[0]));
            child.action.body = body;
            mockDraftRules.set('child', child);
            _applyDraftToLocal('child', child);
          }
          globalThis.exercise = async () => {
            editChild('FIRST');
            ${change === 'toggle' ? "toggleMockGroupEnabled('group'); toggleMockGroupEnabled('group');" : "renameMockGroup('group');"}
            editChild('LATEST');
            await loadMockRules();
            if (mockRules[0].items[0].action.body !== 'LATEST') throw new Error('Reload lost the child draft');
            ${save === 'all' ? 'await saveAllMockRules();' : "await saveOneMockRule('child'); await saveOneMockRule('group');"}
            return mockDraftRules.size;
          };
        `, context);
        assert.equal(await context.exercise(), 0);
        const stored = proxy.mockRules[0];
        assert.equal(stored.items[0].action.body, 'LATEST');
        assert.equal(stored.items[0].id, 'child');
        assert.equal(stored.enabled, true);
        assert.equal(stored.title, change === 'rename' ? 'Renamed' : 'Original');
      });
    }
  }
});

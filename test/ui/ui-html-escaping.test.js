import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return source.slice(start, end);
}

function openingTagAttributeNames(tag) {
  const names = [];
  let index = tag.indexOf(' ');
  while (index >= 0 && index < tag.length) {
    while (/\s/.test(tag[index])) index++;
    if (tag[index] === '>' || tag[index] === '/' || index >= tag.length) break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index++;
    names.push(tag.slice(nameStart, index));
    while (/\s/.test(tag[index])) index++;
    if (tag[index] !== '=') continue;
    index++;
    while (/\s/.test(tag[index])) index++;
    const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : '';
    if (quote) {
      while (index < tag.length && tag[index] !== quote) index++;
      if (tag[index] === quote) index++;
    } else {
      while (index < tag.length && !/[\s>]/.test(tag[index])) index++;
    }
  }
  return names;
}

test('Send tabs and response status render untrusted text through DOM properties', () => {
  const tabs = functionSource('renderSendTabs', 'renderSendResponseStatus');
  const status = functionSource('renderSendResponseStatus', 'cloneSendFormFields');

  assert.doesNotMatch(tabs, /innerHTML/);
  assert.match(tabs, /labelEl\.textContent = label/);
  assert.match(tabs, /tabEl\.title = tab\.url/);
  assert.match(status, /badge\.textContent =/);
  assert.match(status, /statusEl\.replaceChildren\(badge\)/);
  assert.doesNotMatch(source, /statusHtml[^\n]*statusMessage/);
});

test('persisted TLS settings are escaped before list markup is parsed', () => {
  assert.match(source, /\$\{esc\(h\)\}<\/span>/);
  assert.match(source, /\$\{esc\(c\.host\)\} &rarr; \$\{esc\(c\.pfxPath\)\}/);
  assert.match(source, /\$\{esc\(c\)\}<\/span>/);
});

test('traffic rows keep imported methods and sources inside their intended attributes', () => {
  const rowRenderer = functionSource('buildRowHtml', 'renderVirtualRows');
  const attributeEscaper = functionSource('escapeHtmlAttribute', 'getSafeImageDataUri');
  const detailRenderer = functionSource('renderDetailCards', 'autoSizeExportEditor');
  const context = {
    wsFramesByParent: {},
    wsExpandedConnections: new Set(),
    formatSize: value => String(value || 0),
    esc: value => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'),
    isSelectedTrafficRequest: () => false,
    trafficRowDomId: request => `row-${request.id}`,
    trafficRowIdentityAttributes: request => `data-id="${request.id}" data-lifecycle-id=""`,
    isWebSocketConnection: () => false,
    isConnectedWebSocket: () => false,
    wsConnectionKey: request => request.id
  };
  vm.createContext(context);
  vm.runInContext(`
    const SOURCE_ICONS = {
      proxy: '<i class="safe-proxy-icon"></i>',
      'Node.js': '<i class="safe-node-icon"></i>'
    };
    ${attributeEscaper}
    ${rowRenderer}
    globalThis.renderTrafficRow = buildRowHtml;
  `, context);

  const hostile = '" data-audit="present"><img src=x onerror=alert(1)>';
  const hostileHtml = context.renderTrafficRow({
    id: 'hostile',
    method: `GET${hostile}`,
    source: `proxy${hostile}`,
    statusCode: 200,
    host: 'example.test',
    path: '/',
    pinned: false
  }, 0);
  const methodTag = hostileHtml.match(/<span class="method-badge[^>]*>/)?.[0];
  const sourceTag = hostileHtml.match(/<span class="source-icon[^>]*>/)?.[0];
  assert.ok(methodTag);
  assert.ok(sourceTag);
  assert.deepEqual(openingTagAttributeNames(methodTag), ['class']);
  assert.deepEqual(openingTagAttributeNames(sourceTag), ['class', 'title']);
  assert.match(methodTag, /method-GET&quot; data-audit=&quot;present&quot;&gt;&lt;img/);
  assert.match(sourceTag, /source-proxy&quot; data-audit=&quot;present&quot;&gt;&lt;img/);
  assert.doesNotMatch(hostileHtml, /<img src=x/);

  const legitimateHtml = context.renderTrafficRow({
    id: 'legitimate',
    method: 'M-SEARCH',
    source: 'Node.js',
    statusCode: 207,
    host: 'example.test',
    path: '/',
    pinned: false
  }, 0);
  assert.match(legitimateHtml, /class="method-badge method-M-SEARCH">M-SEARCH<\/span>/);
  assert.match(legitimateHtml, /class="source-icon source-Node\.js" title="Node\.js"/);

  assert.match(detailRenderer, /title="\$\{escapeHtmlAttribute\(wsSourceLabel\)\}"/);
  assert.match(detailRenderer, /title="\$\{escapeHtmlAttribute\(sourceLabel\)\}"/);
  assert.match(detailRenderer, /detail-summary-value">\$\{esc\(req\.source \|\| 'proxy'\)\}/);
});

test('custom themes discard unknown or unsafe values and build previews with DOM APIs', () => {
  const sanitizer = functionSource('sanitizeCustomThemeData', 'applyCustomThemeData');
  const preview = functionSource('renderCustomThemeSwatches', 'uploadCustomTheme');

  assert.match(sanitizer, /_themeOverridableVars\.indexOf\(varName\) !== -1/);
  assert.match(sanitizer, /isSafeCustomThemeValue\(varName, value\)/);
  assert.doesNotMatch(preview, /innerHTML/);
  assert.match(preview, /swatch\.title =/);
  assert.match(preview, /swatch\.style\.backgroundColor = s\.color/);
  assert.match(source, /JSON\.stringify\(sanitizedTheme\)/);
});

test('mock, group, and breakpoint IDs stay in escaped data attributes', () => {
  const mockRule = functionSource('renderMockRuleRow', 'renderMockGroup');
  const mockGroup = functionSource('renderMockGroup', '_countAllMockRules');
  const breakpointRule = functionSource('renderBreakpointRuleRow', 'toggleBreakpointRuleEnabled');

  assert.match(mockRule, /data-rule-id="' \+ escapeHtmlAttribute\(rule\.id\) \+ '"/);
  assert.match(mockGroup, /data-group-id="' \+ escapeHtmlAttribute\(group\.id\) \+ '"/);
  assert.match(breakpointRule, /data-breakpoint-id="' \+ escapeHtmlAttribute\(rule\.id\) \+ '"/);

  assert.doesNotMatch(mockRule, /onclick="[^"]*' \+ rule\.id/);
  assert.doesNotMatch(mockRule, /ondrag(?:start|over|drop)="[^"]*' \+ rule\.id/);
  assert.doesNotMatch(mockGroup, /on(?:click|dragover|drop)="[^"]*' \+ group\.id/);
  assert.doesNotMatch(breakpointRule, /onclick="[^"]*' \+ rule\.id/);

  assert.match(mockRule, /this\.closest\(\\'\.mock-rule-card\\'\)\.dataset\.ruleId/);
  assert.match(mockGroup, /this\.closest\(\\'\.mock-group\\'\)\.dataset\.groupId/);
  assert.match(breakpointRule, /this\.closest\(\\'\.mock-breakpoint-rule\\'\)\.dataset\.breakpointId/);
  assert.match(source, /api\/breakpoints\/' \+ encodeURIComponent\(ruleId\)/);
  assert.match(source, /api\/mock-rules\/\$\{encodeURIComponent\(ruleId\)\}/);
  assert.match(source, /api\/mock-rules\/' \+ encodeURIComponent\(groupId\)/);
});

test('mock and breakpoint method summaries escape text and class attributes', () => {
  const attributeEscaper = functionSource('escapeHtmlAttribute', 'getSafeImageDataUri');
  const textEscaper = functionSource('esc', 'formatSize');
  const normalizer = functionSource('normalizeMockRule', 'mockRuleSummary');
  const mockSummary = functionSource('mockRuleSummary', 'renderMockRuleRow');
  const mockRow = functionSource('renderMockRuleRow', 'renderMockGroup');
  const breakpointSummary = functionSource('breakpointRuleSummary', 'renderBreakpointRuleRow');
  const breakpointRow = functionSource(
    'renderBreakpointRuleRow', 'toggleBreakpointRuleEnabled'
  ).replace(/\s*async\s*$/, '\n');
  const context = {
    MOCK_METHOD_COLORS: { '*': '#888' },
    mockExpandedRules: new Set(),
    mockEditingRule: null,
    mockDraftRules: new Set(),
    mockRenamingRuleId: null,
    mockEditDraft: null,
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockResetInProgress: false,
    mockCollectionMutationCount: 0,
    _findContainingMockGroup: () => null,
    renderMockRuleDetail: () => '',
    renderMockRuleEditor: () => '',
    document: {
      createElement() {
        return {
          innerHTML: '',
          set textContent(value) {
            this.innerHTML = String(value)
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;');
          }
        };
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${attributeEscaper}
    ${textEscaper}
    ${normalizer}
    ${mockSummary}
    ${mockRow}
    ${breakpointSummary}
    ${breakpointRow}
    globalThis.renderMock = renderMockRuleRow;
    globalThis.renderBreakpoint = renderBreakpointRuleRow;
  `, context);

  const hostileMethod = 'GET" data-audit="present"></span><img src=x onerror=alert(1)>';
  const mockHtml = context.renderMock({
    id: 'mock',
    enabled: true,
    matchers: [{ type: 'method', value: hostileMethod }],
    action: { type: 'fixed-response', status: 200 }
  });
  const breakpointHtml = context.renderBreakpoint({
    id: 'breakpoint',
    enabled: true,
    matchers: [{ type: 'method', value: hostileMethod }]
  });

  for (const html of [mockHtml, breakpointHtml]) {
    const methodTag = html.match(/<span class="method-badge[^>]*>/)?.[0];
    assert.ok(methodTag);
    assert.deepEqual(openingTagAttributeNames(methodTag), ['class', 'style']);
    assert.match(methodTag, /method-GET&quot; data-audit=&quot;present&quot;&gt;&lt;\/span&gt;&lt;img/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }

  const customMockHtml = context.renderMock({
    id: 'custom-mock',
    enabled: true,
    matchers: [{ type: 'method', value: 'M-SEARCH' }],
    action: { type: 'fixed-response', status: 200 }
  });
  const customBreakpointHtml = context.renderBreakpoint({
    id: 'custom-breakpoint',
    enabled: true,
    matchers: [{ type: 'method', value: 'CUSTOM+METHOD' }]
  });
  assert.match(customMockHtml, /class="method-badge method-M-SEARCH"[^>]*>M-SEARCH<\/span>/);
  assert.match(customBreakpointHtml, /class="method-badge method-CUSTOM\+METHOD"[^>]*>CUSTOM\+METHOD<\/span>/);
});

test('newly created mock lookup compares data values instead of building a selector from the ID', () => {
  const createMock = functionSource('createMockFromRequest', 'showHeaderContextMenu');

  assert.match(createMock, /querySelectorAll\('\[data-rule-id\]'\)/);
  assert.match(createMock, /candidate\.dataset\.ruleId === data\.rule\.id/);
  assert.doesNotMatch(createMock, /querySelector\('\[data-rule-id="' \+ data\.rule\.id/);
});

test('expanded mock editor actions never interpolate the persisted rule ID', () => {
  const editorSource = functionSource('renderMockRuleEditor', 'renderMockMatcherRow');
  const renderRulesSource = functionSource('renderMockRules', 'breakpointRuleSummary');
  const context = {
    MOCK_ACTION_TYPES: [{ value: 'fixed-response', label: 'Return a fixed response' }],
    renderMockMatcherRow: () => '',
    renderMockPreStepRow: () => '',
    renderMockActionFields: () => ''
  };
  vm.createContext(context);
  vm.runInContext(`${editorSource}; globalThis.renderEditor = renderMockRuleEditor;`, context);

  const hostileId = 'x\');" autofocus onfocus="globalThis.__xss=1"><img src=x onerror="globalThis.__xss=2">\\&/tail';
  const html = context.renderEditor({
    priority: 'normal',
    matchers: [],
    preSteps: [],
    action: { type: 'fixed-response' }
  }, hostileId);

  assert.match(html, /saveMockRule\(this\.closest\('\.mock-rule-card'\)\.dataset\.ruleId\)/);
  assert.doesNotMatch(html, /" autofocus|onfocus=|<img|onerror=/);
  assert.doesNotMatch(editorSource, /saveMockRule\(\\'' \+ ruleId/);
  assert.match(renderRulesSource, /data-rule-id="__new__"/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');
const generatedNameHelperStart = source.indexOf('function addGeneratedControlAccessibleNames(');
const generatedNameHelperEnd = source.indexOf('const API_BASE', generatedNameHelperStart);
assert.ok(generatedNameHelperStart >= 0 && generatedNameHelperEnd > generatedNameHelperStart);
const generatedNameHelper = source.slice(generatedNameHelperStart, generatedNameHelperEnd);

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

function decodeHtml(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function quotedAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\s${escapedName}="([^"]*)"`));
  assert.ok(match, `${name} should be a quoted attribute on ${tag}`);
  return decodeHtml(match[1]);
}

function openingTags(html, tagName) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'g'))].map(match => match[0]);
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
  const remoteEndpointFormatter = functionSource('formatRemoteEndpoint', 'buildRowHtml');
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
      'Node.js': '<i class="safe-node-icon"></i>',
      'tls-error': '<i class="safe-tls-icon"></i>',
      tunnel: '<i class="safe-tunnel-icon"></i>'
    };
    ${attributeEscaper}
    ${remoteEndpointFormatter}
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

  const importedHost = 'api" & <host>.test';
  const importedPath = '/"quoted"?one=1&two=<path>';
  const standardHtml = context.renderTrafficRow({
    id: 'quoted-standard',
    method: 'GET',
    source: 'proxy',
    statusCode: 200,
    host: importedHost,
    path: importedPath,
    pinned: false
  }, 0);
  const standardTitleCells = openingTags(standardHtml, 'td')
    .filter(tag => openingTagAttributeNames(tag).includes('title'));
  assert.equal(standardTitleCells.length, 2);
  assert.deepEqual(
    standardTitleCells.map(tag => quotedAttribute(tag, 'title')),
    [importedHost, importedPath]
  );

  const framePayload = 'frame "one" & <two>';
  const frameHtml = context.renderTrafficRow({
    id: 'quoted-frame',
    protocol: 'ws-frame',
    direction: 'client',
    requestBody: framePayload,
    requestBodySize: framePayload.length
  }, 0);
  const framePreview = openingTags(frameHtml, 'td')
    .find(tag => openingTagAttributeNames(tag).includes('class') &&
      quotedAttribute(tag, 'class') === 'ws-frame-preview');
  assert.ok(framePreview);
  assert.equal(quotedAttribute(framePreview, 'title'), framePayload);

  const tlsError = 'certificate "unknown" & <rejected>';
  const tlsHtml = context.renderTrafficRow({
    id: 'quoted-tls',
    protocol: 'tls-error',
    source: 'tls-error',
    host: importedHost,
    error: tlsError
  }, 0);
  const tlsTitleCell = openingTags(tlsHtml, 'td')
    .find(tag => openingTagAttributeNames(tag).includes('title'));
  assert.ok(tlsTitleCell);
  assert.equal(quotedAttribute(tlsTitleCell, 'title'), tlsError);

  const tunnelAddress = 'edge "one" & <two>';
  const tunnelHtml = context.renderTrafficRow({
    id: 'quoted-tunnel',
    protocol: 'tunnel',
    source: 'tunnel',
    host: importedHost,
    remote: { address: tunnelAddress, port: 9443 }
  }, 0);
  const tunnelTitleCell = openingTags(tunnelHtml, 'td')
    .find(tag => openingTagAttributeNames(tag).includes('title'));
  assert.ok(tunnelTitleCell);
  assert.equal(quotedAttribute(tunnelTitleCell, 'title'), `Tunnel to ${tunnelAddress}:9443`);

  assert.deepEqual(
    standardTitleCells.map(openingTagAttributeNames),
    [['role', 'title'], ['role', 'title']]
  );
  assert.deepEqual(
    openingTagAttributeNames(framePreview),
    ['role', 'colspan', 'class', 'title']
  );
  for (const tag of [tlsTitleCell, tunnelTitleCell]) {
    assert.deepEqual(openingTagAttributeNames(tag), ['role', 'colspan', 'style', 'title']);
  }

  assert.match(detailRenderer, /title="\$\{escapeHtmlAttribute\(wsSourceLabel\)\}"/);
  assert.match(detailRenderer, /title="\$\{escapeHtmlAttribute\(sourceLabel\)\}"/);
  assert.match(detailRenderer, /detail-summary-value">\$\{esc\(req\.source \|\| 'proxy'\)\}/);
});

test('imported header names stay in one context-menu data field', () => {
  const headerRenderer = functionSource('renderHeadersGrid', 'renderHeaders');
  const context = {
    HEADER_DOCS: {},
    esc: value => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'),
    escapeHtmlAttribute: value => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  };
  vm.createContext(context);
  vm.runInContext(`
    let _detailHeaderScope = 0;
    const _headerCollapsed = Object.create(null);
    ${headerRenderer};
    globalThis.renderHeadersForTest = renderHeadersGrid;
  `, context);

  const key = 'x-"quoted"-&-<header>';
  const value = 'value "quoted" & <visible>';
  const html = context.renderHeadersForTest({ [key]: value }, 'request');
  const spans = openingTags(html, 'span');
  const headerName = spans.find(tag => quotedAttribute(tag, 'class') === 'header-name');
  const headerValue = spans.find(tag => quotedAttribute(tag, 'class') === 'header-value');
  assert.ok(headerName);
  assert.ok(headerValue);

  for (const tag of [headerName, headerValue]) {
    assert.deepEqual(openingTagAttributeNames(tag), [
      'class', 'role', 'tabindex', 'aria-haspopup', 'data-context-header-key',
      'data-context-section', 'oncontextmenu'
    ]);
    assert.equal(quotedAttribute(tag, 'data-context-header-key'), key);
    assert.equal(quotedAttribute(tag, 'data-context-section'), 'request');
    assert.equal(
      quotedAttribute(tag, 'oncontextmenu'),
      'showHeaderContextMenu(event, this.dataset.contextHeaderKey, this.dataset.contextSection)'
    );
  }

  const nameText = html.match(/<span class="header-name"[^>]*>([\s\S]*?)<\/span>/)?.[1];
  const valueText = html.match(/<span class="header-value"[^>]*>([\s\S]*?)<\/span>/)?.[1];
  assert.equal(decodeHtml(nameText), `${key}: `);
  assert.equal(decodeHtml(valueText), value);
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

test('mock and breakpoint summaries retain constraints and escape text and class attributes', () => {
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
  for (const hostname of ['example.test', '::1', '<img src=x onerror=alert(1)>']) {
    const rule = {
      id: 'hostname-rule', enabled: true,
      matchers: [{ type: 'hostname', value: hostname }, { type: 'path', value: '/resource' }, { type: 'port', value: '8080' }],
      action: { type: 'fixed-response', status: 200 }
    };
    const row = context.renderMock(rule);
    const escapedHostname = hostname.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    assert.ok(row.includes(escapedHostname), hostname);
    assert.ok(row.includes('/resource'));
    assert.ok(row.includes(':8080'));
    assert.doesNotMatch(row, /<img/);
    const hostnameOnly = context.mockRuleSummary({ ...rule, matchers: [rule.matchers[0]] });
    const wildcard = context.mockRuleSummary({ ...rule, matchers: [{ type: 'wildcard' }] });
    assert.notEqual(hostnameOnly.matchStr, wildcard.matchStr);
  }
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

  const persistedTitle = 'rule "quoted" & <named>';
  context.mockRenamingRuleId = 'rename-mock';
  const renameHtml = context.renderMock({
    id: 'rename-mock',
    title: persistedTitle,
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  });
  const renameInput = openingTags(renameHtml, 'input')
    .find(tag => quotedAttribute(tag, 'id') === 'mock-rename-input');
  assert.ok(renameInput);
  assert.equal(quotedAttribute(renameInput, 'value'), persistedTitle);
  assert.deepEqual(openingTagAttributeNames(renameInput), [
    'id', 'class', 'type', 'value', 'placeholder', 'aria-label', 'onkeydown', 'onblur'
  ]);
  assert.equal(quotedAttribute(renameInput, 'aria-label'), 'Rule name');
});

test('persisted matcher, action, and pre-step text round-trips through editor fields', () => {
  const matcherRenderer = functionSource('renderMockMatcherRow', 'renderMockActionFields');
  const actionRenderer = functionSource('renderMockActionFields', 'preserveOpenMockEdit');
  const preStepRenderer = functionSource('renderMockPreStepRow', 'addMockPreStep');
  const headerRowHelpers = functionSource('mockHeaderEditorRows', 'updateMockRespHeader');
  const context = {
    MOCK_MATCHER_GROUPS: [{
      group: 'Request "fields" & <matchers>',
      items: [
        { value: 'header', label: 'Header' },
        { value: 'unused" & <type>', label: 'Unused " & <type>' }
      ]
    }],
    MOCK_PRE_STEP_TYPES: [
      { value: 'add-header', label: 'Add header' },
      { value: 'unused" & <step>', label: 'Unused " & <step>' }
    ],
    esc: value => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'),
    escapeHtmlAttribute: value => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  };
  vm.createContext(context);
  vm.runInContext(`
    ${generatedNameHelper}
    ${matcherRenderer}
    ${headerRowHelpers}
    ${actionRenderer}
    ${preStepRenderer}
    globalThis.renderMatcherForTest = renderMockMatcherRow;
    globalThis.renderActionForTest = renderMockActionFields;
    globalThis.renderPreStepForTest = renderMockPreStepRow;
  `, context);

  const matcherName = 'x-"matcher"-&-<name>';
  const matcherValue = 'matcher "value" & <one>';
  const matcherHtml = context.renderMatcherForTest({
    type: 'header',
    name: matcherName,
    value: matcherValue
  }, 0, 'rule');
  const matcherInputs = openingTags(matcherHtml, 'input');
  assert.deepEqual(
    matcherInputs.map(tag => quotedAttribute(tag, 'value')),
    [matcherName, matcherValue]
  );
  const matcherOptions = openingTags(matcherHtml, 'option');
  assert.equal(quotedAttribute(matcherOptions[1], 'value'), 'unused" & <type>');
  const matcherOptgroup = openingTags(matcherHtml, 'optgroup')[0];
  assert.equal(quotedAttribute(matcherOptgroup, 'label'), 'Request "fields" & <matchers>');

  const actionHeader = 'x-"action"-&-<name>';
  const actionValue = 'action "value" & <two>';
  const actionBody = 'body "quoted" & <textarea>';
  const actionHtml = context.renderActionForTest({
    type: 'fixed-response',
    status: 201,
    delay: 0,
    headers: { [actionHeader]: actionValue },
    body: actionBody
  }, 'rule');
  const actionTextInputs = openingTags(actionHtml, 'input')
    .filter(tag => quotedAttribute(tag, 'type') === 'text');
  assert.deepEqual(
    actionTextInputs.map(tag => quotedAttribute(tag, 'value')),
    [actionHeader, actionValue]
  );
  const repeatedActionHtml = context.renderActionForTest({
    type: 'fixed-response',
    status: 200,
    headers: { 'Set-Cookie': ['first=1', 'second=2'] },
    body: ''
  }, 'rule');
  assert.deepEqual(
    openingTags(repeatedActionHtml, 'input')
      .filter(tag => quotedAttribute(tag, 'type') === 'text')
      .map(tag => quotedAttribute(tag, 'value')),
    ['Set-Cookie', 'first=1', 'Set-Cookie', 'second=2']
  );
  const repeatedTransformHtml = context.renderActionForTest({
    type: 'transform-request',
    resHeadersMode: 'update',
    resHeaders: { Warning: ['199 first', '299 second'] }
  }, 'rule');
  assert.deepEqual(
    openingTags(repeatedTransformHtml, 'input')
      .filter(tag => ['Header name', 'Value'].includes(quotedAttribute(tag, 'placeholder')))
      .map(tag => quotedAttribute(tag, 'value')),
    ['Warning', '199 first', 'Warning', '299 second']
  );
  const textareaBody = actionHtml.match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
  assert.equal(decodeHtml(textareaBody), actionBody);

  const forwardTo = 'https://forward.test/"route"?one=1&two=<value>';
  const forwardHtml = context.renderActionForTest({
    type: 'forward',
    forwardTo,
    delay: 0
  }, 'rule');
  const forwardInput = openingTags(forwardHtml, 'input')
    .find(tag => quotedAttribute(tag, 'type') === 'text');
  assert.ok(forwardInput);
  assert.equal(quotedAttribute(forwardInput, 'value'), forwardTo);

  const stepName = 'x-"step"-&-<name>';
  const stepValue = 'step "value" & <three>';
  const stepHtml = context.renderPreStepForTest({
    type: 'add-header',
    name: stepName,
    value: stepValue
  }, 0, 'rule');
  const stepInputs = openingTags(stepHtml, 'input');
  assert.deepEqual(
    stepInputs.map(tag => quotedAttribute(tag, 'value')),
    [stepName, stepValue]
  );
  const zeroStepHtml = context.renderPreStepForTest({
    type: 'add-header',
    name: 'x-zero',
    value: 0
  }, 1, 'rule');
  assert.deepEqual(
    openingTags(zeroStepHtml, 'input').map(tag => quotedAttribute(tag, 'value')),
    ['x-zero', '0']
  );
  const stepOptions = openingTags(stepHtml, 'option');
  assert.equal(quotedAttribute(stepOptions[1], 'value'), 'unused" & <step>');

  const customMatcherHtml = context.renderMatcherForTest({
    type: 'method', value: 'M-SEARCH'
  }, 2, 'rule');
  const customMatcherInput = openingTags(customMatcherHtml, 'input')[0];
  assert.equal(quotedAttribute(customMatcherInput, 'value'), 'M-SEARCH');
  assert.equal(quotedAttribute(customMatcherInput, 'list'), 'sendMethodOptions');
  assert.match(quotedAttribute(customMatcherInput, 'onchange'), /updateMockMatcher\(2, 'value', this\.value/);

  const customTransformHtml = context.renderActionForTest({
    type: 'transform-request', methodMode: 'CUSTOM+METHOD'
  }, 'rule');
  const customTransformInput = openingTags(customTransformHtml, 'input')
    .find(tag => quotedAttribute(tag, 'title') === 'Enter original or any valid HTTP method token');
  assert.ok(customTransformInput);
  assert.equal(quotedAttribute(customTransformInput, 'value'), 'CUSTOM+METHOD');
  assert.match(quotedAttribute(customTransformInput, 'onchange'), /methodMode=this\.value/);

  const originalTransformHtml = context.renderActionForTest({
    type: 'transform-request'
  }, 'rule');
  const originalTransformInput = openingTags(originalTransformHtml, 'input')
    .find(tag => quotedAttribute(tag, 'title') === 'Enter original or any valid HTTP method token');
  assert.equal(quotedAttribute(originalTransformInput, 'value'), 'original');

  const customMethodStepHtml = context.renderPreStepForTest({
    type: 'rewrite-method', value: 'M-SEARCH'
  }, 3, 'rule');
  const customMethodStepInput = openingTags(customMethodStepHtml, 'input')[0];
  assert.equal(quotedAttribute(customMethodStepInput, 'value'), 'M-SEARCH');
  assert.equal(quotedAttribute(customMethodStepInput, 'list'), 'sendMethodOptions');
  assert.match(quotedAttribute(customMethodStepInput, 'onchange'), /updateMockPreStep\(3, 'value', this\.value/);

  for (const renderer of [matcherRenderer, actionRenderer, preStepRenderer]) {
    assert.doesNotMatch(renderer, /value="' \+ esc\(/);
  }
  assert.match(matcherRenderer, /<textarea[^\n]*' \+ esc\(matcher\.value \|\| ''\) \+ '<\/textarea>/);
  assert.match(actionRenderer, /<textarea[^\n]*' \+ esc\(action\.body \|\| ''\) \+ '<\/textarea>/);
});

test('mock rule details preserve numeric-zero header values', () => {
  const detailRenderer = functionSource('renderMockRuleDetail', 'renderMockRuleEditor');
  const context = {
    esc: value => value === null || value === undefined ? '' : String(value),
    formatBody: value => String(value ?? '')
  };
  vm.createContext(context);
  vm.runInContext(`${detailRenderer}; globalThis.renderDetail = renderMockRuleDetail;`, context);

  const fixed = context.renderDetail({
    matchers: [], preSteps: [],
    action: { type: 'fixed-response', status: 200, headers: { 'X-Zero': 0 } }
  });
  assert.match(fixed, /X-Zero: 0/);

  const webhook = context.renderDetail({
    matchers: [], preSteps: [],
    action: { type: 'webhook', webhookUrl: 'https:\/\/hook.test', webhookHeaders: { 'X-Zero': 0 } }
  });
  assert.match(webhook, /X-Zero: 0/);
  for (const value of [0, '0', '']) {
    const preStep = context.renderDetail({
      matchers: [], preSteps: [{ type: 'add-header', name: 'X-Counter', value }],
      action: { type: 'passthrough' }
    });
    assert.ok(preStep.includes(`X-Counter: ${value}</div>`));
  }
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
    renderMockActionFields: () => '',
    esc: value => String(value ?? ''),
    escapeHtmlAttribute: value => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
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

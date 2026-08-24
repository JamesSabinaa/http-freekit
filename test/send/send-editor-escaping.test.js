import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { parseCurlCommand } from '../../src/ui/curl-parser.js';
import { normalizeHarEntries } from '../../src/ui/har-import.js';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return source.slice(start, end);
}

const attributeEscaperSource = sourceBetween(
  'function escapeHtmlAttribute(',
  'function getSafeImageDataUri('
);
const formRendererSource = sourceBetween(
  'function getSendMultipartFilePresentation(',
  'function addSendFormField('
);
const headerNormalizerSource = sourceBetween(
  'function normalizeSendHeaderRows(',
  'function parseSendTabId('
);
const headerRendererSource = sourceBetween(
  'let sendHeadersList = [];',
  '// ============ SEND TAB MANAGEMENT'
);
const sendTabAllocatorSource = sourceBetween(
  'function parseSendTabId(',
  'function createEmptySendTab('
);
const resendSource = sourceBetween(
  'function resendSelectedRequest(',
  '// Track collapsed state'
);

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function decodeHtmlEntities(value) {
  return String(value).replace(
    /&(?:quot|apos|amp|lt|gt|#39|#x27);/gi,
    entity => ({
      '&quot;': '"',
      '&apos;': "'",
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&#39;': "'",
      '&#x27;': "'"
    })[entity.toLowerCase()]
  );
}

function parseMarkup(markup) {
  const elements = [];
  let cursor = 0;

  while ((cursor = markup.indexOf('<', cursor)) !== -1) {
    cursor++;
    if (markup[cursor] === '/' || markup[cursor] === '!' || markup[cursor] === '?') {
      const closingBracket = markup.indexOf('>', cursor);
      cursor = closingBracket === -1 ? markup.length : closingBracket + 1;
      continue;
    }

    const tagStart = cursor;
    while (cursor < markup.length && /[\w-]/.test(markup[cursor])) cursor++;
    if (cursor === tagStart) continue;
    const tagName = markup.slice(tagStart, cursor).toLowerCase();
    const attributes = new Map();

    while (cursor < markup.length) {
      while (/\s/.test(markup[cursor])) cursor++;
      if (markup[cursor] === '>') {
        cursor++;
        break;
      }
      if (markup[cursor] === '/' && markup[cursor + 1] === '>') {
        cursor += 2;
        break;
      }

      const nameStart = cursor;
      while (cursor < markup.length && !/[\s=/>]/.test(markup[cursor])) cursor++;
      const name = markup.slice(nameStart, cursor).toLowerCase();
      if (!name) {
        cursor++;
        continue;
      }

      while (/\s/.test(markup[cursor])) cursor++;
      let attributeValue = '';
      if (markup[cursor] === '=') {
        cursor++;
        while (/\s/.test(markup[cursor])) cursor++;
        const quote = markup[cursor] === '"' || markup[cursor] === "'" ? markup[cursor++] : '';
        const valueStart = cursor;
        if (quote) {
          while (cursor < markup.length && markup[cursor] !== quote) cursor++;
          attributeValue = markup.slice(valueStart, cursor);
          if (markup[cursor] === quote) cursor++;
        } else {
          while (cursor < markup.length && !/[\s>]/.test(markup[cursor])) cursor++;
          attributeValue = markup.slice(valueStart, cursor);
        }
      }
      attributes.set(name, decodeHtmlEntities(attributeValue));
    }

    elements.push({ tagName, attributes });
  }

  return elements;
}

class MarkupContainer {
  set innerHTML(value) {
    this.markup = String(value);
    this.elements = parseMarkup(this.markup);
  }

  get innerHTML() {
    return this.markup || '';
  }
}

function textInputs(container) {
  return container.elements.filter(element =>
    element.tagName === 'input' && element.attributes.get('type') === 'text'
  );
}

function assertNoInjectedMarkup(container) {
  assert.equal(container.elements.some(element => element.tagName === 'img'), false);
  assert.equal(container.elements.some(element => element.attributes.has('data-audit')), false);
  assert.equal(container.elements.some(element => element.attributes.has('onerror')), false);
}

function replaceGeneratedHtmlPreservingFocus(container, html) {
  container.innerHTML = html;
}

function renderHeaderRows(rows) {
  const container = new MarkupContainer();
  const hidden = { value: '' };
  const context = {
    __rows: rows,
    document: {
      getElementById(id) {
        if (id === 'sendHeaderRows') return container;
        if (id === 'sendHeaders') return hidden;
        return null;
      }
    },
    esc: escapeText,
    replaceGeneratedHtmlPreservingFocus
  };
  vm.createContext(context);
  vm.runInContext(`
    ${attributeEscaperSource}
    ${headerRendererSource}
    sendHeadersList = __rows;
    renderSendHeaders();
  `, context);
  return container;
}

function renderHeaderObject(headers) {
  const container = new MarkupContainer();
  const hidden = { value: '' };
  const context = {
    __headers: headers,
    document: {
      getElementById(id) {
        if (id === 'sendHeaderRows') return container;
        if (id === 'sendHeaders') return hidden;
        return null;
      }
    },
    esc: escapeText,
    replaceGeneratedHtmlPreservingFocus
  };
  vm.createContext(context);
  vm.runInContext(`
    ${attributeEscaperSource}
    ${headerNormalizerSource}
    ${headerRendererSource}
    loadSendHeadersFromJson(JSON.stringify(__headers));
  `, context);
  return container;
}

function renderFormFields(fields, bodyType) {
  const container = new MarkupContainer();
  const context = {
    __fields: fields,
    __bodyType: bodyType,
    document: {
      getElementById: id => id === 'sendFormBodyRows' ? container : null
    },
    esc: escapeText,
    getSendBodyType: () => context.__bodyType,
    getActiveSendFormFields: () => context.__fields,
    replaceGeneratedHtmlPreservingFocus
  };
  vm.createContext(context);
  vm.runInContext(`
    ${attributeEscaperSource}
    ${formRendererSource}
    renderSendFormFields();
  `, context);
  return container;
}

function resendRequest(request) {
  let loadedTab = null;
  const context = {
    selectedRequestId: request.id,
    selectedRequestLifecycleId: null,
    requests: [request],
    sendTabs: [],
    sendTabCounter: 0,
    activeSendTab: 'tab-1',
    URLSearchParams,
    saveSendTabState() {},
    document: { querySelector: () => null },
    loadSendTabState: tab => { loadedTab = tab; },
    renderSendTabs() {},
    toast() {},
    findHeaderKey: (headers, name) => Object.keys(headers)
      .find(key => key.toLowerCase() === name.toLowerCase()) || null
  };
  context.trafficActionRequest = requestId =>
    context.requests.find(candidate => candidate.id === requestId) || null;
  vm.createContext(context);
  vm.runInContext(`
    ${sendTabAllocatorSource}
    ${resendSource}
    resendSelectedRequest();
  `, context);
  return loadedTab;
}

const hostileValue = '" data-audit="present"><img src=x onerror=alert(1)>';
const legitimateValue = `A&B "quoted" 'single' <literal>`;

test('Send header value attributes preserve exact text without creating markup', () => {
  const hostileKey = `X-Audit${hostileValue}`;
  const container = renderHeaderRows([
    { key: hostileKey, value: hostileValue, enabled: true },
    { key: 'X-Legitimate', value: legitimateValue, enabled: true }
  ]);
  const inputs = textInputs(container);

  assert.deepEqual(inputs.map(input => input.attributes.get('value')), [
    hostileKey,
    hostileValue,
    'X-Legitimate',
    legitimateValue
  ]);
  assertNoInjectedMarkup(container);
  assert.match(container.innerHTML, /&quot; data-audit=&quot;present&quot;&gt;&lt;img/);
  assert.match(container.innerHTML, /A&amp;B &quot;quoted&quot; &#39;single&#39; &lt;literal&gt;/);
});

test('Send URL-encoded and multipart text fields use safe value attributes', () => {
  const fields = [
    { key: `field${hostileValue}`, value: hostileValue, enabled: true, type: 'text' },
    { key: 'legitimate', value: legitimateValue, enabled: true, type: 'text' }
  ];

  for (const bodyType of ['urlencoded', 'multipart']) {
    const container = renderFormFields(fields, bodyType);
    assert.deepEqual(textInputs(container).map(input => input.attributes.get('value')), [
      `field${hostileValue}`,
      hostileValue,
      'legitimate',
      legitimateValue
    ], bodyType);
    assertNoInjectedMarkup(container);
  }

  assert.doesNotMatch(formRendererSource, /value="\$\{esc\(/);
  assert.doesNotMatch(headerRendererSource, /value="\$\{esc\(/);
});

test('HAR-imported headers and form values stay literal when resent', () => {
  const formKey = `field${hostileValue}`;
  const body = new URLSearchParams([
    [formKey, hostileValue],
    ['legitimate', legitimateValue]
  ]).toString();
  const [request] = normalizeHarEntries({
    log: {
      entries: [{
        startedDateTime: '2026-08-15T00:00:00.000Z',
        time: 1,
        request: {
          method: 'POST',
          url: 'https://example.test/submit',
          headers: [
            { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
            { name: 'X-Audit', value: hostileValue },
            { name: 'X-Legitimate', value: legitimateValue }
          ],
          postData: {
            mimeType: 'application/x-www-form-urlencoded',
            text: body
          }
        },
        response: { status: 200, headers: [] }
      }]
    }
  }, { createId: () => 'har-request' });

  const tab = resendRequest(request);
  assert.ok(tab);
  assert.equal(tab.headers.find(header => header.key === 'x-audit').value, hostileValue);
  assert.deepEqual(JSON.parse(JSON.stringify(
    tab.urlEncodedFields.map(field => [field.key, field.value])
  )), [
    [formKey, hostileValue],
    ['legitimate', legitimateValue]
  ]);

  const headerContainer = renderHeaderRows(tab.headers);
  const formContainer = renderFormFields(tab.urlEncodedFields, tab.bodyType);
  assert.ok(textInputs(headerContainer).some(input => input.attributes.get('value') === hostileValue));
  assert.deepEqual(textInputs(formContainer).map(input => input.attributes.get('value')), [
    formKey,
    hostileValue,
    'legitimate',
    legitimateValue
  ]);
  assertNoInjectedMarkup(headerContainer);
  assertNoInjectedMarkup(formContainer);
});

test('pasted cURL header values stay literal when loaded into Send', () => {
  const quotedCurlValue = legitimateValue
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
  const parsed = parseCurlCommand(
    `curl https://example.test -H 'X-Audit: ${hostileValue}' ` +
    `-H "X-Legitimate: ${quotedCurlValue}"`
  );
  assert.ok(parsed);
  assert.equal(parsed.headers['X-Audit'], hostileValue);
  assert.equal(parsed.headers['X-Legitimate'], legitimateValue);

  const container = renderHeaderObject(parsed.headers);
  assert.deepEqual(textInputs(container).map(input => input.attributes.get('value')), [
    'X-Audit',
    hostileValue,
    'X-Legitimate',
    legitimateValue
  ]);
  assertNoInjectedMarkup(container);
});

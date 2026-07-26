import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return appSource.slice(start, end);
}

const headerLookupSource = sourceBetween('function findHeaderValues(', 'function matchesFilter(');
const detailSource = sourceBetween('function renderDetailCards(', 'function getExportFormFields(');
const headerGridSource = sourceBetween('function renderHeadersGrid(', '// Keep old renderHeaders as alias');
const bodyModeSource = sourceBetween('function isGrpcContentType(', 'const activeBodyEditors = {}');
const breakpointEditSource = sourceBetween('function getBreakpointEditDraft(', 'async function resumeBreakpointRequest(');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pausedRequest(phase) {
  return {
    id: `paused-${phase}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'https',
    method: 'POST',
    host: 'example.test',
    url: 'https://example.test/<edit>?a=1&b=2',
    path: '/<edit>',
    source: 'breakpoint',
    breakpointPhase: phase,
    statusCode: 0,
    statusMessage: '',
    upstreamStatusCode: 202,
    requestHeaders: { 'x-request': '<request>' },
    responseHeaders: { 'x-response': '<response>' },
    requestBody: '<request-body>&',
    responseBody: '<response-body>&',
    requestBodySize: 15,
    responseBodySize: 16,
    duration: 0
  };
}

function renderPausedDetail(phase) {
  const detailContent = { innerHTML: '' };
  const context = {
    HEADER_DOCS: {},
    SOURCE_ICONS: { Other: '' },
    URL,
    URLSearchParams,
    _transformPerspective: 'transformed',
    _urlBreakdownOpen: false,
    console,
    disposeBodyEditor: () => {},
    document: { getElementById: id => id === 'detailContent' ? detailContent : null },
    esc: escapeHtml,
    formatBodyAs: body => escapeHtml(body),
    formatSize: size => `${size || 0} bytes`,
    getBreakpointEditDraft: request => phase === 'response' ? {
      _phase: 'response',
      status: request.upstreamStatusCode,
      headers: request.responseHeaders,
      body: request.responseBody,
      _dirty: {}
    } : {
      _phase: 'request',
      method: request.method,
      url: request.url,
      headers: request.requestHeaders,
      body: request.requestBody,
      _dirty: {}
    },
    getEffectiveRequest: value => value,
    renderBodyViewer: () => {},
    renderUrlBreakdown: () => '',
    window: {}
  };

  vm.createContext(context);
  vm.runInContext(`
    ${headerLookupSource}
    ${headerGridSource}
    ${bodyModeSource}
    ${detailSource}
    globalThis.renderDetailCardsForTest = renderDetailCards;
  `, context);
  context.renderDetailCardsForTest(pausedRequest(phase));
  return detailContent.innerHTML;
}

function renderedControl(html, field) {
  const match = html.match(new RegExp(`<(?:span|pre)\\b[^>]*id="breakpoint-edit-${field}"[^>]*>`));
  assert.ok(match, `${field} control must be rendered`);
  return match[0];
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]+)"`));
  assert.ok(match, `${name} must be rendered on ${tag}`);
  return match[1];
}

test('paused request and response fields render as named, instructed keyboard buttons', () => {
  const phases = [
    {
      phase: 'request',
      fields: [
        ['method', 'Edit request method'],
        ['url', 'Edit request URL'],
        ['headers', 'Edit request headers'],
        ['body', 'Edit request body']
      ]
    },
    {
      phase: 'response',
      fields: [
        ['status', 'Edit response status'],
        ['headers', 'Edit response headers'],
        ['body', 'Edit response body']
      ]
    }
  ];

  for (const { phase, fields } of phases) {
    const html = renderPausedDetail(phase);
    assert.match(html, /id="breakpoint-edit-instructions"[^>]*>Double-click a field, or focus it and press Enter or Space, to edit before resuming\.<\/div>/);
    assert.doesNotMatch(html, /<request(?:-body)?(?:>|&)|<response(?:-body)?(?:>|&)/, 'editable values stay HTML-escaped');

    for (const [field, accessibleName] of fields) {
      const control = renderedControl(html, field);
      assert.equal(attribute(control, 'role'), 'button');
      assert.equal(attribute(control, 'tabindex'), '0');
      assert.equal(attribute(control, 'aria-label'), accessibleName);
      assert.equal(attribute(control, 'aria-describedby'), 'breakpoint-edit-instructions');
      assert.match(attribute(control, 'onkeydown'), new RegExp(`^activateBreakpointFieldOnKeyboard\\(event, 'paused-${phase}', '${field}'\\)$`));

      const doubleClickCalls = [];
      vm.runInNewContext(attribute(control, 'ondblclick'), {
        editBreakpointField: (...args) => doubleClickCalls.push(args)
      });
      assert.deepEqual(doubleClickCalls, [[`paused-${phase}`, field]], `${phase} ${field} double-click still edits once`);
    }
  }
});

function createEditHarness() {
  const requests = [pausedRequest('request'), pausedRequest('response')];
  const breakpointEditDrafts = new Map();
  const prompts = [];
  const promptCalls = [];
  const renders = [];
  const toasts = [];
  const focusTargets = new Map();
  let focusLookups = 0;

  const context = {
    breakpointEditDrafts,
    requests,
    prompt: (...args) => {
      promptCalls.push(args);
      return prompts.shift();
    },
    toast: (...args) => toasts.push(args),
    renderDetailCards: request => {
      renders.push(request.id);
      for (const field of ['status', 'method', 'url', 'headers', 'body']) {
        const target = { focusCount: 0, focus() { this.focusCount++; } };
        focusTargets.set(field, target);
      }
    },
    document: {
      getElementById: id => {
        focusLookups++;
        return focusTargets.get(id.replace('breakpoint-edit-', '')) || null;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${breakpointEditSource}
    globalThis.activateForTest = activateBreakpointFieldOnKeyboard;
    globalThis.getDraftForTest = getBreakpointEditDraft;
  `, context);

  return {
    context,
    prompts,
    promptCalls,
    renders,
    toasts,
    focusTargets,
    get focusLookups() { return focusLookups; }
  };
}

function keyboardEvent(key, overrides = {}) {
  const control = {};
  const state = { prevented: 0 };
  return {
    state,
    event: {
      key,
      target: control,
      currentTarget: control,
      repeat: false,
      preventDefault: () => { state.prevented++; },
      ...overrides
    }
  };
}

test('Enter and Space edit every breakpoint field once and restore focus after rerender', () => {
  const harness = createEditHarness();
  const cases = [
    ['paused-response', 'status', 'Enter', '204', draft => assert.equal(draft.status, 204)],
    ['paused-response', 'headers', ' ', '{"x-response":"changed"}', draft => assert.equal(draft.headers['x-response'], 'changed')],
    ['paused-response', 'body', 'Enter', '  response body  ', draft => assert.equal(draft.body, '  response body  ')],
    ['paused-request', 'method', ' ', 'patch', draft => assert.equal(draft.method, 'PATCH')],
    ['paused-request', 'url', 'Enter', ' https://changed.test/path ', draft => assert.equal(draft.url, 'https://changed.test/path')],
    ['paused-request', 'headers', ' ', '{"x-request":"changed"}', draft => assert.equal(draft.headers['x-request'], 'changed')],
    ['paused-request', 'body', 'Enter', '  request body  ', draft => assert.equal(draft.body, '  request body  ')]
  ];

  for (const [requestId, field, key, answer, assertValue] of cases) {
    const priorPromptCount = harness.promptCalls.length;
    const priorRenderCount = harness.renders.length;
    const oldFocusTarget = harness.focusTargets.get(field);
    harness.prompts.push(answer);
    const { event, state } = keyboardEvent(key);

    harness.context.activateForTest(event, requestId, field);

    assert.equal(state.prevented, 1, `${key === ' ' ? 'Space' : key} prevents its native action`);
    assert.equal(harness.promptCalls.length, priorPromptCount + 1, `${requestId} ${field} opens one prompt`);
    assert.equal(harness.renders.length, priorRenderCount + 1, `${requestId} ${field} rerenders once`);
    assert.equal(oldFocusTarget?.focusCount || 0, 0, 'the detached control is not refocused');
    assert.equal(harness.focusTargets.get(field).focusCount, 1, `${requestId} ${field} regains focus`);
    const draft = harness.context.getDraftForTest(harness.context.requests.find(request => request.id === requestId));
    assert.equal(draft._dirty[field], true);
    assertValue(draft);
  }
});

test('keyboard activation ignores repeats, nested targets and unrelated keys without duplicate edits', () => {
  const harness = createEditHarness();
  const scenarios = [
    keyboardEvent('Enter', { repeat: true }),
    keyboardEvent(' ', { repeat: true }),
    keyboardEvent('Escape'),
    keyboardEvent('Enter', { target: {} })
  ];

  for (const { event } of scenarios) harness.context.activateForTest(event, 'paused-request', 'method');

  assert.equal(scenarios[0].state.prevented, 1);
  assert.equal(scenarios[1].state.prevented, 1, 'repeated Space is still prevented from scrolling');
  assert.equal(scenarios[2].state.prevented, 0);
  assert.equal(scenarios[3].state.prevented, 0);
  assert.equal(harness.promptCalls.length, 0);
  assert.equal(harness.renders.length, 0);
});

test('cancelled and invalid prompts do not rerender, refocus, or dirty breakpoint drafts', () => {
  const harness = createEditHarness();
  const attempts = [
    ['paused-response', 'status', null],
    ['paused-response', 'status', '99'],
    ['paused-request', 'headers', '[]'],
    ['paused-request', 'body', null]
  ];

  for (const [requestId, field, answer] of attempts) {
    harness.prompts.push(answer);
    const beforeRenders = harness.renders.length;
    const beforeFocusLookups = harness.focusLookups;
    const { event } = keyboardEvent('Enter');
    harness.context.activateForTest(event, requestId, field);
    assert.equal(harness.renders.length, beforeRenders);
    assert.equal(harness.focusLookups, beforeFocusLookups);
    const draft = harness.context.getDraftForTest(harness.context.requests.find(request => request.id === requestId));
    assert.equal(draft._dirty[field], undefined);
  }

  assert.equal(harness.promptCalls.length, attempts.length);
  assert.deepEqual(harness.toasts.map(args => args[1]), ['error', 'error']);
});

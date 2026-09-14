import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const fetchWrapperStart = rendererSource.indexOf('const API_BASE =');
const fetchWrapperEnd = rendererSource.indexOf('// ============ WEBSOCKET ============', fetchWrapperStart);
assert.notEqual(fetchWrapperStart, -1);
assert.notEqual(fetchWrapperEnd, -1);
const functionsStart = rendererSource.indexOf('let breakpointBannerGeneration = 0;');
const functionsEnd = rendererSource.indexOf('function getBreakpointEditDraft(', functionsStart);
assert.notEqual(functionsStart, -1);
assert.notEqual(functionsEnd, -1);
const singleResumeStart = rendererSource.indexOf('function breakpointDraftKey(');
const singleResumeEnd = rendererSource.indexOf('function createBreakpointFromRequest(', singleResumeStart);
assert.notEqual(singleResumeStart, -1);
assert.notEqual(singleResumeEnd, -1);
const singleResumeSource = rendererSource.slice(singleResumeStart, singleResumeEnd);

function response(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function createRenderer(fetch, breakpointEditDrafts = new Map()) {
  const elements = {
    breakpointBanner: { style: { display: 'flex' } },
    breakpointBannerText: { textContent: 'stale count' }
  };
  const toasts = [];
  const context = {
    API_BASE: '',
    breakpointEditDrafts,
    fetch,
    document: { getElementById: id => elements[id] || null },
    console,
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(rendererSource.slice(functionsStart, functionsEnd), context);
  return { context, elements, toasts };
}

test('only the latest pending-list refresh can update the breakpoint banner', async () => {
  for (const latestPending of [[], [{ id: 'new-pause' }]]) {
    const requests = [];
    const harness = createRenderer(() => new Promise(resolve => requests.push(resolve)));
    const older = harness.context.updateBreakpointBanner();
    const newer = harness.context.updateBreakpointBanner();
    requests[1](response({ pending: latestPending }));
    await newer;
    requests[0](response({ pending: latestPending.length ? [] : [{ id: 'already-resumed' }] }));
    await older;
    assert.equal(harness.elements.breakpointBanner.style.display, latestPending.length ? 'flex' : 'none');
    if (latestPending.length) assert.equal(harness.elements.breakpointBannerText.textContent, '1 request paused');
  }
});

test('management fetch errors preserve their HTTP status for callers', async () => {
  const nativeResponse = {
    ok: false,
    status: 404,
    clone: () => ({ json: async () => ({ error: 'Pending breakpoint not found' }) })
  };
  const location = {
    hostname: '127.0.0.1',
    port: '9000',
    search: '?authToken=test-token',
    origin: 'http://127.0.0.1:9000',
    href: 'http://127.0.0.1:9000/?authToken=test-token'
  };
  const context = {
    Headers,
    Request,
    URL,
    URLSearchParams,
    window: { location, fetch: async () => nativeResponse }
  };
  vm.createContext(context);
  vm.runInContext(rendererSource.slice(fetchWrapperStart, fetchWrapperEnd), context);

  await assert.rejects(
    context.window.fetch('/api/breakpoints/pending/stale/resume'),
    error => error.message === 'Pending breakpoint not found' && error.status === 404
  );
});

test('Resume All skips a stale breakpoint, resumes later entries, and refreshes the banner', async () => {
  const calls = [];
  let pendingRead = 0;
  const renderer = createRenderer(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/breakpoints/pending') {
      pendingRead++;
      return response({ pending: pendingRead === 1 ? [{ id: 'a' }, { id: 'b' }] : [] });
    }
    if (url.endsWith('/a/resume')) {
      throw Object.assign(new Error('Pending breakpoint not found'), { status: 404 });
    }
    if (url.endsWith('/b/resume')) return response({ success: true });
    return assert.fail(`Unexpected fetch: ${url}`);
  });

  await renderer.context.resumeAllBreakpoints();

  assert.deepEqual(calls, [
    { url: '/api/breakpoints/pending', method: 'GET' },
    { url: '/api/breakpoints/pending/a/resume', method: 'POST' },
    { url: '/api/breakpoints/pending/b/resume', method: 'POST' },
    { url: '/api/breakpoints/pending', method: 'GET' }
  ]);
  assert.equal(renderer.elements.breakpointBanner.style.display, 'none');
  assert.deepEqual(renderer.toasts, [{ message: 'All breakpoints resumed', type: 'success' }]);
});

test('Resume All continues after other failures and reports the refreshed pending count', async () => {
  const resumedIds = [];
  let pendingRead = 0;
  const renderer = createRenderer(async (url, options = {}) => {
    if (url === '/api/breakpoints/pending') {
      pendingRead++;
      return response({ pending: pendingRead === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'a' }] });
    }
    const id = url.split('/').at(-2);
    resumedIds.push(id);
    if (id === 'a') return response({ error: 'Resume unavailable' }, { ok: false, status: 503 });
    if (id === 'b' && options.method === 'POST') return response({ success: true });
    return assert.fail(`Unexpected fetch: ${url}`);
  });

  await renderer.context.resumeAllBreakpoints();

  assert.deepEqual(resumedIds, ['a', 'b']);
  assert.equal(renderer.elements.breakpointBanner.style.display, 'flex');
  assert.equal(renderer.elements.breakpointBannerText.textContent, '1 request paused');
  assert.deepEqual(renderer.toasts, [{
    message: '1 breakpoint could not be resumed: Resume unavailable',
    type: 'error'
  }]);
});

test('Resume All targets duplicate IDs by traffic lifecycle', async () => {
  const calls = [];
  let pendingRead = 0;
  const breakpointEditDrafts = new Map([
    [JSON.stringify(['same/id', 'life 1']), { _phase: 'request' }],
    [JSON.stringify(['same/id', 'life&2']), { _phase: 'request' }]
  ]);
  const renderer = createRenderer(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/breakpoints/pending') {
      pendingRead++;
      return response({
        pending: pendingRead === 1 ? [
          { id: 'same/id', trafficLifecycleId: 'life 1' },
          { id: 'same/id', trafficLifecycleId: 'life&2' }
        ] : []
      });
    }
    return response({ success: true });
  }, breakpointEditDrafts);

  await renderer.context.resumeAllBreakpoints();

  assert.deepEqual(calls, [
    { url: '/api/breakpoints/pending', method: 'GET' },
    {
      url: '/api/breakpoints/pending/same%2Fid/resume?trafficLifecycleId=life%201',
      method: 'POST'
    },
    {
      url: '/api/breakpoints/pending/same%2Fid/resume?trafficLifecycleId=life%262',
      method: 'POST'
    },
    { url: '/api/breakpoints/pending', method: 'GET' }
  ]);
  assert.equal(breakpointEditDrafts.size, 0);
  assert.deepEqual(renderer.toasts, [{ message: 'All breakpoints resumed', type: 'success' }]);
});

test('Resume All sends dirty edits for each lifecycle and retains failed drafts', async () => {
  const requestDraft = { _phase: 'request', _dirty: { method: true, headers: true, body: true },
    method: 'PATCH', url: 'https://unchanged.test/', headers: { 'X-Edited': 'request' }, body: 'EDITED REQUEST' };
  const responseDraft = { _phase: 'response', _dirty: { status: true, body: true, method: true },
    status: 201, headers: { 'X-Unchanged': 'response' }, body: 'EDITED RESPONSE', method: 'DELETE' };
  const requestKey = JSON.stringify(['same', 'request-life']);
  const responseKey = JSON.stringify(['same', 'response-life']);
  const drafts = new Map([[requestKey, requestDraft], [responseKey, responseDraft]]);
  const bodies = [];
  let pendingRead = 0;
  const pending = [{ id: 'same', trafficLifecycleId: 'request-life' },
    { id: 'same', trafficLifecycleId: 'response-life' }, { id: 'untouched' }];
  const renderer = createRenderer(async (url, options = {}) => {
    if (!options.method) return response({ pending: pendingRead++ === 0 ? pending : [pending[1]] });
    bodies.push(JSON.parse(options.body));
    return url.includes('response-life')
      ? response({ error: 'Retry required' }, { ok: false })
      : response({ success: true });
  }, drafts);
  await renderer.context.resumeAllBreakpoints();
  assert.deepEqual(bodies, [
    { method: 'PATCH', headers: { 'X-Edited': 'request' }, body: 'EDITED REQUEST' },
    { status: 201, body: 'EDITED RESPONSE' },
    {}
  ]);
  assert.equal(drafts.has(requestKey), false);
  assert.equal(drafts.get(responseKey), responseDraft);
  assert.match(renderer.toasts[0].message, /1 breakpoint could not be resumed/);
});

test('manual resume sends only the selected lifecycle draft', async () => {
  const calls = [];
  const toasts = [];
  const breakpointEditDrafts = new Map([
    [JSON.stringify(['duplicate/id', 'life-1']), {
      _phase: 'request', body: 'first edit', _dirty: { body: true }
    }],
    [JSON.stringify(['duplicate/id', 'life-2']), {
      _phase: 'request', body: 'second edit', _dirty: { body: true }
    }]
  ]);
  const context = {
    API_BASE: '',
    breakpointEditDrafts,
    requests: [],
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({ success: true });
    },
    toast: (...args) => toasts.push(args),
    updateBreakpointBanner: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(`
    ${singleResumeSource}
    globalThis.resumeForTest = resumeBreakpointRequest;
  `, context);

  await context.resumeForTest('duplicate/id', 'life-2');

  assert.deepEqual(calls, [{
    url: '/api/breakpoints/pending/duplicate%2Fid/resume?trafficLifecycleId=life-2',
    body: { body: 'second edit' }
  }]);
  assert.equal(breakpointEditDrafts.has(JSON.stringify(['duplicate/id', 'life-1'])), true);
  assert.equal(breakpointEditDrafts.has(JSON.stringify(['duplicate/id', 'life-2'])), false);
  assert.deepEqual(toasts, [['Request resumed', 'success']]);
});

test('manual resume clears only the selected stale lifecycle draft', async () => {
  const toasts = [];
  let bannerRefreshes = 0;
  const breakpointEditDrafts = new Map([
    [JSON.stringify(['duplicate/id', 'life-1']), { _phase: 'request' }],
    [JSON.stringify(['duplicate/id', 'life-2']), { _phase: 'request' }]
  ]);
  const context = {
    API_BASE: '',
    breakpointEditDrafts,
    requests: [],
    fetch: async () => {
      throw Object.assign(new Error('Pending breakpoint not found'), { status: 404 });
    },
    toast: (...args) => toasts.push(args),
    updateBreakpointBanner: async () => { bannerRefreshes++; }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${singleResumeSource}
    globalThis.resumeForTest = resumeBreakpointRequest;
  `, context);

  await context.resumeForTest('duplicate/id', 'life-2');

  assert.equal(breakpointEditDrafts.has(JSON.stringify(['duplicate/id', 'life-1'])), true);
  assert.equal(breakpointEditDrafts.has(JSON.stringify(['duplicate/id', 'life-2'])), false);
  assert.equal(bannerRefreshes, 1);
  assert.deepEqual(toasts, [['Request is no longer paused', 'success']]);
});

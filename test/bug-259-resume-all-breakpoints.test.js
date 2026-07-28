import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const functionsStart = rendererSource.indexOf('async function updateBreakpointBanner()');
const functionsEnd = rendererSource.indexOf('function getBreakpointEditDraft(', functionsStart);
assert.notEqual(functionsStart, -1);
assert.notEqual(functionsEnd, -1);

function response(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function createRenderer(fetch) {
  const elements = {
    breakpointBanner: { style: { display: 'flex' } },
    breakpointBannerText: { textContent: 'stale count' }
  };
  const toasts = [];
  const context = {
    API_BASE: '',
    fetch,
    document: { getElementById: id => elements[id] || null },
    console,
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(rendererSource.slice(functionsStart, functionsEnd), context);
  return { context, elements, toasts };
}

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
      return response({ error: 'Pending breakpoint not found' }, { ok: false, status: 404 });
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
  });

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
  assert.deepEqual(renderer.toasts, [{ message: 'All breakpoints resumed', type: 'success' }]);
});

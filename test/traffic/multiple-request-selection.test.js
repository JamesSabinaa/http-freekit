import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('src/ui/app.js', 'utf8');
function between(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function harness() {
  const rows = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, trafficLifecycleId: id }));
  const details = [];
  const confirmations = [];
  const deleted = [];
  const button = {};
  const context = vm.createContext({
    requests: rows,
    filteredRequests: [...rows],
    selectedRequestId: null,
    selectedRequestLifecycleId: null,
    vsForceRender: false,
    trafficDetailSelectionGeneration: 0,
    document: { getElementById: id => id === 'deleteTrafficSelectionBtn' ? button : null },
    window: { location: { hash: '#/view' } },
    history: { replaceState() {} },
    buildTrafficViewHash: id => '#/view/' + id,
    scrollRowIntoView() {},
    renderSelectedTrafficDetail: req => details.push(req.id),
    toast() {},
    confirm: message => { confirmations.push(message); return true; }
  });
  vm.runInContext(`
    ${between('function normalizeTrafficLifecycleId(', 'function mergeServerTrafficRequest(')}
    ${between('let deferredTrafficGenerationTokens = new WeakMap();', 'function mergeTrafficRequestWithRendererState(')}
    ${between('function updateTrafficActiveDescendant(', 'const deferredTrafficHydrations = new Map();')}
    ${between('function closeDetail(', '// ============ DETAIL FOOTER ACTIONS')}
    ${between('function trafficActionGenerationRequest(', 'function withResolvedTrafficAction(')}
    ${between('function deleteSelectedRequest(', 'async function deleteResolvedRequest(')}
    function renderVirtualRows() { updateTrafficSelectionActions(); }
    globalThis.api = {
      click(index, modifiers = {}) {
        const req = filteredRequests[index];
        selectTrafficRow({ preventDefault() {}, ...modifiers }, req.id, req.trafficLifecycleId);
      },
      selected: () => selectedTrafficRequests().map(req => req.id),
      highlighted: req => isTrafficRowSelected(req),
      deleteSelectedRequest, deleteTrafficSelection, closeDetail,
      transferTrafficGenerationToken, ensureTrafficGenerationToken
    };
  `, context);
  context.deleteResolvedRequest = async (req, confirmed) => {
    assert.equal(confirmed, true);
    deleted.push(req.id);
    context.requests = context.requests.filter(row => row !== req);
  };
  context.withResolvedTrafficAction = async (id, lifecycle, label, action, token) => {
    const req = context.trafficActionGenerationRequest(id, lifecycle, token);
    if (req) await action(req);
  };
  return { context, rows, details, confirmations, deleted, button, api: context.api };
}

test('Ctrl-click toggles requests without replacing the first detail; plain click returns to one', () => {
  const h = harness();
  h.api.click(1);
  h.api.click(3, { ctrlKey: true });
  h.api.click(0, { ctrlKey: true });
  assert.deepEqual([...h.api.selected()], ['b', 'd', 'a']);
  assert.deepEqual(h.details, ['b']);
  assert.equal(h.api.highlighted(h.rows[3]), true);
  assert.equal(h.button.textContent, 'Delete 3 selected');
  h.api.click(3, { ctrlKey: true });
  assert.deepEqual([...h.api.selected()], ['b', 'a']);
  h.api.click(1);
  assert.deepEqual([...h.api.selected()], ['b']);
  assert.equal(h.button.hidden, true);
});

test('Shift-click ranges start at the previous click and use visible sorted rows', () => {
  const h = harness();
  h.context.filteredRequests = [h.rows[4], h.rows[2], h.rows[0], h.rows[3]];
  h.api.click(0);
  h.api.click(1, { ctrlKey: true });
  h.api.click(3, { shiftKey: true });
  assert.deepEqual([...h.api.selected()], ['e', 'c', 'a', 'd']);
  assert.deepEqual(h.details, ['e']);
  assert.equal(h.api.highlighted(h.rows[1]), false);
});

test('reverse ranges, Cmd-click, and removing the primary preserve the earliest remaining request', () => {
  const h = harness();
  h.api.click(3);
  h.api.click(1, { shiftKey: true });
  assert.deepEqual([...h.api.selected()], ['d', 'b', 'c']);
  assert.deepEqual(h.details, ['d']);
  h.api.click(3, { metaKey: true });
  assert.deepEqual([...h.api.selected()], ['b', 'c']);
  assert.deepEqual(h.details, ['d', 'b']);
  h.api.closeDetail();
  assert.deepEqual([...h.api.selected()], []);
  assert.equal(h.button.hidden, true);
});

test('Shift-click uses the latest Ctrl-click as its anchor, leaving earlier gaps unselected', () => {
  const h = harness();
  h.api.click(0);
  h.api.click(3, { ctrlKey: true });
  h.api.click(4, { shiftKey: true });
  assert.deepEqual([...h.api.selected()], ['a', 'd', 'e']);
  assert.deepEqual(h.details, ['a']);
});

test('right-clicking a selected row preserves the group and offers bulk deletion for that snapshot', async () => {
  const h = harness();
  let items;
  h.context.trafficActionRequest = (id, lifecycle) => h.context.requests.find(req =>
    req.id === id && req.trafficLifecycleId === lifecycle);
  h.context.showContextMenu = (x, y, actions) => { items = actions; };
  vm.runInContext(between('function showTrafficContextMenu(', 'function copyResponseHeadersForMock('), h.context);
  h.api.click(0);
  h.api.click(2, { ctrlKey: true });
  h.context.showTrafficContextMenu({ preventDefault() {} }, 'c', {}, 'c');
  assert.deepEqual(h.details, ['a']);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Delete 2 selected requests');
  h.api.click(4);
  await items[0].action();
  assert.deepEqual(h.deleted, ['a', 'c']);
  assert.equal(h.context.selectedRequestId, 'e');
});

test('selection survives authoritative updates but never follows a replacement generation', () => {
  const h = harness();
  h.api.click(0);
  h.api.click(2, { ctrlKey: true });
  const updated = { ...h.rows[2], statusCode: 200 };
  h.api.transferTrafficGenerationToken(h.rows[2], updated);
  h.context.requests = [h.rows[0], updated];
  assert.deepEqual([...h.api.selected()], ['a', 'c']);
  h.context.requests = [h.rows[0], { ...updated }];
  assert.deepEqual([...h.api.selected()], ['a']);
});

test('bulk Delete confirms once, preserves pinned requests, and deletes only its snapshot', async () => {
  const h = harness();
  h.rows[1].pinned = true;
  h.api.click(0);
  h.api.click(2, { shiftKey: true });
  const originalDelete = h.context.deleteResolvedRequest;
  h.context.deleteResolvedRequest = async (...args) => {
    await originalDelete(...args);
    h.api.click(4);
  };
  await h.api.deleteSelectedRequest();
  assert.deepEqual(h.deleted, ['a', 'c']);
  assert.deepEqual(h.confirmations, ['Delete 2 selected requests? 1 pinned requests will be kept.']);
  assert.ok(h.context.requests.includes(h.rows[1]));
  assert.ok(h.context.requests.includes(h.rows[4]));
});

test('cancelled bulk Delete changes nothing and stale snapshots cannot delete reused identities', async () => {
  const h = harness();
  h.api.click(0);
  h.api.click(1, { ctrlKey: true });
  h.context.confirm = () => false;
  await h.api.deleteSelectedRequest();
  assert.deepEqual(h.deleted, []);
  h.context.confirm = () => true;
  const stale = [h.rows[0], h.rows[1]];
  h.context.requests = [{ ...h.rows[0] }, { ...h.rows[1] }];
  await h.api.deleteTrafficSelection(stale);
  assert.deepEqual(h.deleted, []);
});

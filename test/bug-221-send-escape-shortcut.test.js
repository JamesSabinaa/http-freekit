import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');

function extract(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return appSource.slice(start, end);
}

const sendAbortFunctions = extract('function abortSendRequest()', '// ============ CONFIG');
const editorShortcuts = extract('function registerSendEditorShortcuts', 'async function initSendBodyEditor');
const documentShortcuts = extract('function isEditableKeyboardTarget', '// ============ MONACO EDITOR');

function createController() {
  const signal = { aborted: false };
  let abortCalls = 0;
  return {
    signal,
    abort() {
      abortCalls++;
      signal.aborted = true;
    },
    get abortCalls() { return abortCalls; }
  };
}

function createHarness({ sendPanelActive = true } = {}) {
  const state = {
    closeCalls: 0,
    keydown: null,
    toasts: []
  };
  const sendPanel = { classList: { contains: name => name === 'active' && sendPanelActive } };
  const context = {
    monacoApi: {
      KeyMod: { CtrlCmd: 1000 },
      KeyCode: { Enter: 1, Escape: 2 }
    },
    document: {
      activeElement: null,
      addEventListener(type, handler) {
        if (type === 'keydown') state.keydown = handler;
      },
      getElementById(id) {
        return id === 'panel-send' ? sendPanel : null;
      },
      querySelector() { return null; }
    },
    closeDetail: () => { state.closeCalls++; },
    toast: (...args) => state.toasts.push(args)
  };
  vm.createContext(context);
  vm.runInContext([
    'let currentSendAbort = null;',
    'let selectedRequestId = null;',
    'let sendTabs = [];',
    "let activeSendTab = 'tab-1';",
    sendAbortFunctions,
    editorShortcuts,
    documentShortcuts,
    `globalThis.escapeApi = {
      setController(controller) { currentSendAbort = controller; },
      registerEditor: registerSendEditorShortcuts
    };`
  ].join('\n'), context);

  function pressEscape(target) {
    let preventCalls = 0;
    context.document.activeElement = target;
    state.keydown({
      key: 'Escape',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target,
      preventDefault() { preventCalls++; }
    });
    return preventCalls;
  }

  return { api: context.escapeApi, context, pressEscape, state };
}

test('document Escape aborts once from every representative non-Monaco Send target', () => {
  const targets = [
    { id: 'sendUrl', tagName: 'INPUT' },
    { className: 'send-header-row', tagName: 'INPUT' },
    { id: 'sendBtn', tagName: 'BUTTON' },
    { id: 'sendResponsePane', tagName: 'DIV' }
  ];

  for (const target of targets) {
    const harness = createHarness();
    const controller = createController();
    harness.api.setController(controller);

    assert.equal(harness.pressEscape(target), 1, `${target.id || target.className} should consume Escape`);
    assert.equal(controller.abortCalls, 1);
    assert.deepEqual(harness.state.toasts, [['Request aborted', 'success']]);
    assert.equal(harness.state.closeCalls, 0);
  }
});

test('Monaco and document delivery share one idempotent abort path', () => {
  const harness = createHarness();
  const controller = createController();
  const commands = new Map();
  harness.api.setController(controller);
  harness.api.registerEditor({ addCommand: (key, callback) => commands.set(key, callback) });

  const escapeCommand = commands.get(harness.context.monacoApi.KeyCode.Escape);
  assert.equal(typeof escapeCommand, 'function');
  escapeCommand();
  harness.pressEscape({ className: 'monaco-editor', tagName: 'TEXTAREA' });
  harness.pressEscape({ id: 'sendResponsePane', tagName: 'DIV' });

  assert.equal(controller.abortCalls, 1);
  assert.deepEqual(harness.state.toasts, [['Request aborted', 'success']]);
  assert.equal(harness.state.closeCalls, 0);
});

test('Escape retains menu and detail behavior when no active Send request owns it', () => {
  const inactiveRequest = createHarness();
  assert.equal(inactiveRequest.pressEscape({ id: 'sendUrl', tagName: 'INPUT' }), 0);
  assert.equal(inactiveRequest.state.closeCalls, 1);
  assert.deepEqual(inactiveRequest.state.toasts, []);

  const inactivePanel = createHarness({ sendPanelActive: false });
  const controller = createController();
  inactivePanel.api.setController(controller);
  assert.equal(inactivePanel.pressEscape({ id: 'trafficList', tagName: 'DIV' }), 0);
  assert.equal(controller.abortCalls, 0);
  assert.equal(inactivePanel.state.closeCalls, 1);

  assert.match(appSource, /if \(e\.key === 'Escape'\) hideContextMenu\(\)/);
});

test('the URL field relies on the document Escape path instead of an inline duplicate', () => {
  const urlInput = html.match(/<input type="url" id="sendUrl"[^>]*>/)?.[0];
  assert.ok(urlInput);
  assert.doesNotMatch(urlInput, /Escape|abortSendRequest/);
});

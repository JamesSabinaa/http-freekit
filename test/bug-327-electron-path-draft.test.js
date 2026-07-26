import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const stateDeclaration = "let electronAppPathDraft = '';";
const renderStart = source.indexOf('function renderElectronConfig(');
const renderEnd = source.indexOf('function renderDockerConfig(', renderStart);
for (const expected of [source.indexOf(stateDeclaration), renderStart, renderEnd]) {
  assert.notEqual(expected, -1);
}
const electronFunctions = source.slice(renderStart, renderEnd);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createHarness({ fetch, selectFilePath } = {}) {
  let currentInput = null;
  let filterCalls = 0;
  let renderCalls = 0;
  const requests = [];
  const toasts = [];
  const container = {
    html: '',
    set innerHTML(value) {
      this.html = value;
      renderCalls += 1;
      currentInput = {
        value: '',
        focused: false,
        focus() { this.focused = true; }
      };
    },
    get innerHTML() { return this.html; },
    querySelector(selector) {
      return selector === '#electronAppPath' ? currentInput : null;
    }
  };
  const context = {
    API_BASE: '',
    NODE_ENV_PROXY_SUPPORT_NOTE: 'Node support note',
    beginInterceptorOperation: () => ({ id: 'electron' }),
    collapseInterceptorCard: () => {},
    console,
    document: {
      getElementById: id => id === 'electronAppPath' ? currentInput : null,
      querySelector: () => null
    },
    esc: value => String(value),
    fetch: async (...args) => {
      requests.push(args);
      return fetch(...args);
    },
    interceptorsInProgress: new Set(),
    isCurrentInterceptorOperation: () => true,
    setTimeout: () => {},
    switchPanel: () => {},
    toast: (message, type) => toasts.push({ message, type }),
    window: {
      electronApi: selectFilePath ? { selectFilePath } : undefined
    }
  };
  vm.createContext(context);
  vm.runInContext(`${stateDeclaration}\n${electronFunctions}`, context);
  context.filterInterceptors = () => {
    filterCalls += 1;
    context.renderElectronConfig(container);
  };

  return {
    container,
    context,
    requests,
    toasts,
    get currentInput() { return currentInput; },
    get filterCalls() { return filterCalls; },
    get renderCalls() { return renderCalls; },
    render: () => context.renderElectronConfig(container)
  };
}

test('typed special-character paths survive card and failed-launch rerenders', async () => {
  const renderTemplate = electronFunctions.slice(0, electronFunctions.indexOf('`;'));
  assert.match(electronFunctions, /input\.value = electronAppPathDraft/);
  assert.doesNotMatch(renderTemplate, /electronAppPathDraft/);
  assert.match(electronFunctions, /oninput="rememberElectronAppPath\(this\.value\);"/);

  const harness = createHarness({
    fetch: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'launch rejected' })
    })
  });
  const rawPath = '  C:\\Apps\\Odd "<&>"\\electron.exe  ';
  harness.render();
  harness.currentInput.value = rawPath;
  harness.context.rememberElectronAppPath(harness.currentInput.value);

  harness.render();
  assert.equal(harness.currentInput.value, rawPath, 'ordinary card rerenders restore the exact draft');

  await harness.context.launchElectronApp();

  assert.equal(harness.filterCalls, 2, 'loading and finally each rebuild the card');
  assert.equal(harness.currentInput.value, rawPath);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(JSON.parse(harness.requests[0][1].body), {
    appPath: rawPath.trim()
  });
  assert.deepEqual(harness.toasts, [{ message: 'Error: launch rejected', type: 'error' }]);
});

test('a deferred picker updates the current input after an intervening rerender', async () => {
  const picker = deferred();
  const harness = createHarness({
    fetch: async () => assert.fail('launch is not expected'),
    selectFilePath: () => picker.promise
  });
  const previousPath = 'C:\\Previous\\electron.exe';
  const selectedPath = 'C:\\Apps\\Picked "<&>"\\electron.exe';
  harness.render();
  harness.currentInput.value = previousPath;
  harness.context.rememberElectronAppPath(previousPath);

  const detachedInput = harness.currentInput;
  const browse = harness.context.browseElectronApp();
  harness.render();
  assert.notEqual(harness.currentInput, detachedInput);
  assert.equal(harness.currentInput.value, previousPath);

  picker.resolve(selectedPath);
  await browse;

  assert.equal(detachedInput.value, previousPath, 'the pre-dialog detached node is not updated');
  assert.equal(harness.currentInput.value, selectedPath);
  harness.render();
  assert.equal(harness.currentInput.value, selectedPath, 'the picker result remains owned after later rerenders');
});

test('picker cancellation preserves the existing path draft', async () => {
  const existingPath = 'C:\\Apps\\Existing\\electron.exe';
  const picker = deferred();
  const harness = createHarness({
    fetch: async () => assert.fail('launch is not expected'),
    selectFilePath: () => picker.promise
  });
  harness.render();
  harness.currentInput.value = existingPath;
  harness.context.rememberElectronAppPath(existingPath);

  const browse = harness.context.browseElectronApp();
  harness.render();
  picker.resolve(null);
  await browse;
  harness.render();

  assert.equal(harness.currentInput.value, existingPath);
});

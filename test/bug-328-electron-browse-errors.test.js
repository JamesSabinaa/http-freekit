import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const browseStart = appSource.indexOf('async function browseElectronApp()');
const browseEnd = appSource.indexOf('async function launchElectronApp()', browseStart);
assert.ok(browseStart >= 0 && browseEnd > browseStart, 'Electron Browse function must be present');
const browseSource = appSource.slice(browseStart, browseEnd);

function createHarness(selectFilePath) {
  const input = {
    value: 'C:\\existing\\application.exe',
    focusCalls: 0,
    focus() { this.focusCalls += 1; }
  };
  const toasts = [];
  const context = {
    document: {
      getElementById: id => id === 'electronAppPath' ? input : null
    },
    window: {
      electronApi: { selectFilePath }
    },
    toast: (...args) => toasts.push(args)
  };
  vm.createContext(context);
  vm.runInContext(`
    ${browseSource}
    globalThis.browseElectronAppForTest = browseElectronApp;
  `, context);
  return { context, input, toasts };
}

test('Electron Browse catches a synchronous preload bridge failure', async () => {
  const harness = createHarness(() => {
    throw new Error('IPC bridge unavailable');
  });

  await assert.doesNotReject(harness.context.browseElectronAppForTest());

  assert.equal(harness.input.value, 'C:\\existing\\application.exe');
  assert.deepEqual(harness.toasts, [[
    'Could not select Electron application: IPC bridge unavailable',
    'error'
  ]]);
});

test('Electron Browse catches a rejected native dialog Promise', async () => {
  const harness = createHarness(() => Promise.reject(new Error('dialog failed')));

  await assert.doesNotReject(harness.context.browseElectronAppForTest());

  assert.equal(harness.input.value, 'C:\\existing\\application.exe');
  assert.deepEqual(harness.toasts, [[
    'Could not select Electron application: dialog failed',
    'error'
  ]]);
});

test('Electron Browse cancellation is quiet and keeps the current input', async () => {
  const harness = createHarness(async () => null);

  await harness.context.browseElectronAppForTest();

  assert.equal(harness.input.value, 'C:\\existing\\application.exe');
  assert.deepEqual(harness.toasts, []);
});

test('Electron Browse success still writes the selected path', async () => {
  const calls = [];
  const harness = createHarness(async options => {
    calls.push(options);
    return 'D:\\Applications\\selected.exe';
  });

  await harness.context.browseElectronAppForTest();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Select Electron application');
  assert.equal(harness.input.value, 'D:\\Applications\\selected.exe');
  assert.deepEqual(harness.toasts, []);
});

test('fire-and-forget Browse invocation does not emit an unhandled rejection', async () => {
  const harness = createHarness(() => Promise.reject(new Error('native picker closed')));

  // Match the inline onclick call, which intentionally does not consume the
  // async function's return value. node:test fails this test if it rejects.
  vm.runInContext('browseElectronAppForTest();', harness.context);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(harness.toasts, [[
    'Could not select Electron application: native picker closed',
    'error'
  ]]);
});

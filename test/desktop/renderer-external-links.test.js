import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');

const downloadStart = renderer.indexOf('const BROWSER_DOWNLOAD_URLS =');
const downloadEnd = renderer.indexOf('// Tags for search filtering', downloadStart);
assert.ok(downloadStart >= 0 && downloadEnd > downloadStart);

function downloadHarness(openExternalUrl, open = () => ({})) {
  const toasts = [];
  const context = {
    confirm: () => true,
    toast: (message, type) => toasts.push({ message, type }),
    window: { open, ...(openExternalUrl ? { electronApi: { openExternalUrl } } : {}) }
  };
  vm.createContext(context);
  vm.runInContext(`let interceptorSelectionGeneration = 0; ${renderer.slice(downloadStart, downloadEnd)}; globalThis.download = downloadBrowser;`, context);
  return { download: context.download, toasts };
}

test('browser download recovery reports launch failures and success only after confirmation', async () => {
  let resolveOpen;
  const success = downloadHarness(() => new Promise(resolve => { resolveOpen = resolve; }));
  const pending = success.download('firefox', 'Firefox');
  assert.deepEqual(success.toasts, []);
  resolveOpen({ success: true });
  await pending;
  assert.deepEqual(success.toasts, [{ message: 'Opening Firefox download page...', type: 'success' }]);

  const failed = downloadHarness(async () => ({ success: false, error: 'no URL handler' }));
  await failed.download('firefox', 'Firefox');
  assert.deepEqual(failed.toasts, [{
    message: 'Could not open the Firefox download page: no URL handler',
    type: 'error'
  }]);

  const blocked = downloadHarness(null, () => null);
  await blocked.download('firefox', 'Firefox');
  assert.equal(blocked.toasts[0].type, 'error');
  assert.match(blocked.toasts[0].message, /blocked the new window/);
});

test('desktop navigation failures use a native error dialog and renderer IPC is allowlisted', async () => {
  const start = main.indexOf('function openExternalWithNativeError(');
  const end = main.indexOf('async function findFreePort', start);
  const dialogs = [];
  const context = {
    mainWindow: { isDestroyed: () => false },
    shell: { openExternal: async () => { throw new Error('policy blocked'); } },
    dialog: { showMessageBox: async (...args) => { dialogs.push(args); } }
  };
  vm.createContext(context);
  vm.runInContext(`${main.slice(start, end)}; globalThis.openLink = openExternalWithNativeError;`, context);
  await context.openLink('https://example.test');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0][1].title, 'Unable to Open Link');
  assert.equal(dialogs[0][1].detail, 'policy blocked');

  assert.equal((main.match(/openExternalWithNativeError\(url\)/g) || []).length, 3);
  assert.match(main, /ipcMain\.handle\('open-external-url'/);
  assert.match(main, /!isSafeExternalUrl\(url\)/);
  assert.match(preload, /'open-external-url'/);
  assert.match(preload, /openExternalUrl:\s*\(url\) => safeInvoke\('open-external-url', url\)/);
});

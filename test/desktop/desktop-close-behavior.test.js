import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CLOSE_WINDOW_BEHAVIORS,
  DEFAULT_CLOSE_WINDOW_BEHAVIOR,
  DESKTOP_PREFERENCES_FILENAME,
  DesktopPreferences
} = require('../../electron/desktop-preferences.cjs');

const repoRoot = process.cwd();
const rendererSource = fs.readFileSync(
  path.join(repoRoot, 'src', 'ui', 'desktop-close-behavior.js'),
  'utf8'
);
const markup = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'index.html'), 'utf8');
const preload = fs.readFileSync(path.join(repoRoot, 'electron', 'preload.cjs'), 'utf8');
const main = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');

function createTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-desktop-preferences-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('desktop preferences default to hiding and persist a validated quit choice', t => {
  const directory = createTempDirectory(t);
  const preferences = new DesktopPreferences(directory);
  assert.equal(preferences.getCloseWindowBehavior(), DEFAULT_CLOSE_WINDOW_BEHAVIOR);
  assert.equal(DEFAULT_CLOSE_WINDOW_BEHAVIOR, CLOSE_WINDOW_BEHAVIORS.HIDE);

  assert.equal(
    preferences.setCloseWindowBehavior(CLOSE_WINDOW_BEHAVIORS.QUIT),
    CLOSE_WINDOW_BEHAVIORS.QUIT
  );
  const reloaded = new DesktopPreferences(directory);
  assert.equal(reloaded.getCloseWindowBehavior(), CLOSE_WINDOW_BEHAVIORS.QUIT);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, DESKTOP_PREFERENCES_FILENAME), 'utf8')),
    { closeWindowBehavior: 'quit' }
  );
});

test('malformed and unsupported preferences safely retain the hide default', t => {
  const directory = createTempDirectory(t);
  const filePath = path.join(directory, DESKTOP_PREFERENCES_FILENAME);
  const errors = [];
  fs.writeFileSync(filePath, '{not json', 'utf8');
  const malformed = new DesktopPreferences(directory, {
    logger: { error: (...args) => errors.push(args.join(' ')) }
  });
  assert.equal(malformed.getCloseWindowBehavior(), 'hide');
  assert.match(errors[0], /Could not load desktop preferences/);

  fs.writeFileSync(filePath, JSON.stringify({ closeWindowBehavior: 'destroy' }), 'utf8');
  const unsupported = new DesktopPreferences(directory);
  assert.equal(unsupported.getCloseWindowBehavior(), 'hide');
  assert.throws(
    () => unsupported.setCloseWindowBehavior('destroy'),
    /must be "hide" or "quit"/
  );
});

test('failed desktop preference writes do not change the live behavior', () => {
  const errors = [];
  const preferences = new DesktopPreferences('C:\\virtual-user-data', {
    fileSystem: {
      existsSync: () => false,
      mkdirSync: () => {},
      writeFileSync: () => {},
      renameSync: () => { throw new Error('simulated replacement failure'); },
      unlinkSync: () => {}
    },
    logger: { error: (...args) => errors.push(args.join(' ')) }
  });

  assert.throws(() => preferences.setCloseWindowBehavior('quit'), /replacement failure/);
  assert.equal(preferences.getCloseWindowBehavior(), 'hide');
  assert.match(errors[0], /Could not save desktop preferences/);
});

function createElement(initial = {}) {
  const classes = new Set();
  return {
    hidden: initial.hidden ?? false,
    disabled: initial.disabled ?? false,
    value: initial.value ?? '',
    textContent: '',
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains: name => classes.has(name)
    }
  };
}

function runRenderer(electronApi) {
  const card = createElement({ hidden: true });
  const select = createElement({ disabled: true, value: 'hide' });
  const status = createElement();
  const elements = new Map([
    ['desktopWindowBehaviorCard', card],
    ['closeWindowBehaviorSelect', select],
    ['closeWindowBehaviorStatus', status]
  ]);
  const listeners = new Map();
  const document = {
    readyState: 'loading',
    getElementById: id => elements.get(id) || null,
    addEventListener: (type, callback, options) => listeners.set(type, { callback, options })
  };
  const window = {};
  if (electronApi !== undefined) window.electronApi = electronApi;
  vm.runInNewContext(rendererSource, { document, Error, Promise, Set, window }, {
    filename: path.join(repoRoot, 'src', 'ui', 'desktop-close-behavior.js')
  });
  return {
    card,
    select,
    status,
    window,
    listenerOptions: listeners.get('DOMContentLoaded')?.options,
    fireDomReady: () => listeners.get('DOMContentLoaded')?.callback()
  };
}

test('desktop close setting hydrates and saves through the restricted bridge', async () => {
  const writes = [];
  const harness = runRenderer({
    getCloseWindowBehavior: async () => 'quit',
    setCloseWindowBehavior: async behavior => {
      writes.push(behavior);
      return behavior;
    }
  });

  assert.equal(harness.card.hidden, true);
  assert.equal(harness.listenerOptions?.once, true);
  await harness.fireDomReady();
  assert.equal(harness.card.hidden, false);
  assert.equal(harness.select.value, 'quit');
  assert.equal(harness.select.disabled, false);

  await harness.window.saveCloseWindowBehavior('hide');
  assert.deepEqual(writes, ['hide']);
  assert.equal(harness.select.value, 'hide');
  assert.equal(harness.select.disabled, false);
  assert.equal(harness.status.textContent, 'Saved');
  assert.equal(harness.status.classList.contains('is-error'), false);
});

test('desktop close setting stays hidden in browser mode and rolls back failed saves', async () => {
  const browser = runRenderer(undefined);
  await browser.fireDomReady();
  assert.equal(browser.card.hidden, true);

  const desktop = runRenderer({
    getCloseWindowBehavior: async () => 'hide',
    setCloseWindowBehavior: async () => { throw new Error('disk full'); }
  });
  await desktop.fireDomReady();
  await desktop.window.saveCloseWindowBehavior('quit');
  assert.equal(desktop.select.value, 'hide');
  assert.equal(desktop.select.disabled, false);
  assert.match(desktop.status.textContent, /disk full/);
  assert.equal(desktop.status.classList.contains('is-error'), true);
});

test('window behavior UI and IPC are wired without exposing unrestricted messaging', () => {
  assert.match(markup, /id="desktopWindowBehaviorCard"[\s\S]*id="closeWindowBehaviorSelect"/);
  assert.match(markup, /Keep running in the system tray/);
  assert.match(markup, /Quit HTTP FreeKit/);
  assert.match(markup, /desktop-close-behavior\.js[\s\S]*app\.js/);
  assert.match(preload, /'get-close-window-behavior'/);
  assert.match(preload, /'set-close-window-behavior'/);
  assert.match(preload, /getCloseWindowBehavior:\s*\(\) => safeInvoke\('get-close-window-behavior'\)/);
  assert.match(preload, /setCloseWindowBehavior:\s*\(behavior\) => safeInvoke\('set-close-window-behavior', behavior\)/);
  assert.match(main, /new DesktopPreferences\(app\.getPath\('userData'\)\)/);
  assert.match(main, /ipcMain\.handle\('set-close-window-behavior',[\s\S]*validateSender\(event\)/);
  assert.doesNotMatch(rendererSource, /ipcRenderer|require\s*\(/);
});

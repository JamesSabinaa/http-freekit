import assert from 'node:assert/strict';
import test from 'node:test';

import { findBrowserPath } from '../src/interceptors/browser-paths.js';

test('browser discovery finds Chromium installations on PATH', () => {
  const expected = '/opt/browser/bin/chromium-browser';
  const result = findBrowserPath('chrome', {
    platform: 'linux',
    env: { PATH: '/opt/browser/bin:/usr/local/bin' },
    existsSync: candidate => candidate === expected
  });

  assert.equal(result, expected);
});

test('browser discovery checks macOS user-local application bundles', () => {
  const expected = '/Users/example/Applications/Firefox.app/Contents/MacOS/firefox';
  const result = findBrowserPath('firefox', {
    platform: 'darwin',
    env: {},
    homeDir: '/Users/example',
    existsSync: candidate => candidate === expected
  });

  assert.equal(result, expected);
});

test('macOS PATH discovery resolves only executables contained in application bundles', () => {
  const pathEntry = '/usr/local/bin/google-chrome';
  const resolved = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const result = findBrowserPath('chrome', {
    platform: 'darwin',
    env: { PATH: '/usr/local/bin' },
    homeDir: '/Users/example',
    existsSync: candidate => candidate === pathEntry,
    realpathSync: candidate => candidate === pathEntry ? resolved : candidate
  });

  assert.equal(result, resolved);
  assert.equal(findBrowserPath('chrome', {
    platform: 'darwin',
    env: { PATH: '/usr/local/bin' },
    homeDir: '/Users/example',
    existsSync: candidate => candidate === pathEntry,
    realpathSync: () => '/opt/portable/google-chrome'
  }), null);
});

test('browser discovery handles the case-insensitive Windows Path variable', () => {
  const expected = 'C:\\Portable\\Browser\\chrome.exe';
  const result = findBrowserPath('chrome', {
    platform: 'win32',
    env: { Path: 'C:\\Portable\\Browser;C:\\Windows' },
    existsSync: candidate => candidate === expected
  });

  assert.equal(result, expected);
});

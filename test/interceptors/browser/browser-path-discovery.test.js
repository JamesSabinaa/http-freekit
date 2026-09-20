import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { findBrowserPath } from '../../../src/interceptors/browser-paths.js';
import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

for (const platform of ['linux', 'darwin']) {
  test(`${platform} browser discovery preserves literal PATH components and exact environment names`, async t => {
    const cwd = '/fixture';
    const fixtures = [
      [{ PATH: '/opt/browser' }, '/opt/browser'],
      [{ PATH: '/opt/browser tools' }, '/opt/browser tools'],
      [{ PATH: '/opt/browser ' }, '/opt/browser '],
      [{ PATH: ' browser' }, ' browser'],
      [{ PATH: '/opt/browser"' }, '/opt/browser"'],
      [{ PATH: '"browser' }, '"browser'],
      ...['', ':/missing', '/missing:', '/missing::/unused'].map(PATH => [{ PATH }, '.']),
      [{ path: '/wrong', PATH: '/opt/browser' }, '/opt/browser'],
      [{ PATH: '/opt/browser', path: '/wrong' }, '/opt/browser'],
      [{ path: '/wrong' }, '/usr/bin']
    ];
    for (const [env, directory] of fixtures) {
      await t.test(JSON.stringify(env), async () => {
        const executable = path.posix.resolve(cwd, directory, platform === 'linux' ? 'chromium' : 'chrome');
        const bundleExecutable = '/Applications/Test Chrome.app/Contents/MacOS/Chrome';
        const lookup = () => findBrowserPath('chrome', {
          platform, env, cwd, existsSync: candidate => candidate === executable,
          realpathSync: candidate => {
            assert.equal(candidate, executable);
            return bundleExecutable;
          }
        });
        assert.equal(lookup(), platform === 'linux' ? executable : bundleExecutable);
        const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
        browser._findBrowserPath = lookup;
        assert.equal(await browser.isActivable(), true);
      });
    }
  });
}

test('Windows browser PATH retains case-insensitive lookup and quoted-directory support', () => {
  const expected = 'C:\\Program Files\\Browser\\chrome.exe';
  assert.equal(findBrowserPath('chrome', {
    platform: 'win32', env: { Path: '"C:\\Program Files\\Browser";C:\\Other' },
    existsSync: candidate => candidate === expected
  }), expected);
});

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

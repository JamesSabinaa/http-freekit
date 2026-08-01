import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = process.cwd();
const source = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'desktop-version.js'), 'utf8');
const markup = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'index.html'), 'utf8');

function createElement({ textContent = '', title = '' } = {}) {
  const attributes = new Map();
  if (title) attributes.set('title', title);
  return {
    textContent,
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value))
  };
}

function runHydrator({ electronApi, includeLogo = true, includeValue = true, readyState = 'loading' } = {}) {
  const logo = createElement({ title: 'HTTP FreeKit v1.0.0' });
  const valueElement = createElement({ textContent: '1.0.0' });
  const elements = new Map();
  if (includeLogo) elements.set('desktopVersionLogo', logo);
  if (includeValue) elements.set('desktopVersionValue', valueElement);
  const listeners = new Map();
  const document = {
    readyState,
    addEventListener(type, callback, options) {
      listeners.set(type, { callback, options });
    },
    getElementById: id => elements.get(id) || null
  };
  const window = {};
  if (electronApi !== undefined) window.electronApi = electronApi;

  vm.runInNewContext(source, { console, document, Promise, window }, {
    filename: path.join(repoRoot, 'src', 'ui', 'desktop-version.js')
  });

  return {
    fireDomReady() {
      listeners.get('DOMContentLoaded')?.callback();
    },
    listenerOptions: listeners.get('DOMContentLoaded')?.options,
    logo,
    valueElement
  };
}

async function settlePromises() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

async function withUnhandledCapture(action) {
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await action();
    await settlePromises();
    return unhandled;
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

function assertStaticFallback(harness) {
  assert.equal(harness.logo.getAttribute('title'), 'HTTP FreeKit v1.0.0');
  assert.equal(harness.valueElement.textContent, '1.0.0');
}

test('version surfaces expose stable hooks and load their focused hydrator', () => {
  assert.match(markup, /id="desktopVersionLogo" title="HTTP FreeKit v1\.0\.0"/);
  assert.match(markup, /id="desktopVersionValue">1\.0\.0<\/span>/);
  assert.match(
    markup,
    /<script src="\/desktop-version\.js"><\/script>\s*<script src="\/desktop-close-behavior\.js"><\/script>\s*<script src="\/app\.js"><\/script>/
  );
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(source, /logo\.setAttribute\('title'/);
  assert.match(source, /valueElement\.textContent = version/);
});

test('valid packaged versions hydrate both locations only after DOM availability', async t => {
  for (const version of ['1.0.1', '2.3.4-beta.1+build.7']) {
    await t.test(version, async () => {
      let calls = 0;
      const harness = runHydrator({
        electronApi: {
          getDesktopVersion: async () => {
            calls += 1;
            return `  ${version}  `;
          }
        }
      });

      assert.equal(calls, 0);
      assertStaticFallback(harness);
      assert.equal(harness.listenerOptions?.once, true);

      harness.fireDomReady();
      await settlePromises();

      assert.equal(calls, 1);
      assert.equal(harness.logo.getAttribute('title'), `HTTP FreeKit v${version}`);
      assert.equal(harness.valueElement.textContent, version);
    });
  }
});

test('browser mode and missing desktop methods retain both static fallbacks', async () => {
  for (const electronApi of [undefined, {}, { getDesktopVersion: null }]) {
    const harness = runHydrator({ electronApi });
    const unhandled = await withUnhandledCapture(async () => {
      harness.fireDomReady();
    });

    assertStaticFallback(harness);
    assert.deepEqual(unhandled, []);
  }
});

test('null, malformed, non-string, and overlong versions retain both fallbacks', async t => {
  const invalidVersions = [
    null,
    undefined,
    '',
    '   ',
    'v1.0.1',
    '1.0',
    '1.0.1\nforged',
    '<img src=x onerror=alert(1)>',
    { version: '1.0.1' },
    `1.0.1-${'x'.repeat(65)}`
  ];

  for (const version of invalidVersions) {
    await t.test(String(version), async () => {
      const harness = runHydrator({
        electronApi: { getDesktopVersion: async () => version }
      });
      const unhandled = await withUnhandledCapture(async () => {
        harness.fireDomReady();
      });

      assertStaticFallback(harness);
      assert.deepEqual(unhandled, []);
    });
  }
});

test('desktop-version failures and unavailable elements are safely ignored', async t => {
  const failures = [
    { name: 'rejected Promise', getDesktopVersion: () => Promise.reject(new Error('IPC rejected')) },
    { name: 'synchronous error', getDesktopVersion: () => { throw new Error('bridge unavailable'); } }
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const harness = runHydrator({
        electronApi: { getDesktopVersion: failure.getDesktopVersion },
        readyState: 'complete'
      });
      const unhandled = await withUnhandledCapture(async () => {});
      assertStaticFallback(harness);
      assert.deepEqual(unhandled, []);
    });
  }

  await t.test('both elements unavailable', async () => {
    const harness = runHydrator({
      electronApi: { getDesktopVersion: async () => '1.0.1' },
      includeLogo: false,
      includeValue: false,
      readyState: 'complete'
    });
    const unhandled = await withUnhandledCapture(async () => {});
    assertStaticFallback(harness);
    assert.deepEqual(unhandled, []);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';
import { ExistingBrowserInterceptor } from '../../../src/interceptors/existing-browser-interceptor.js';

const BROAD_TLS_BYPASSES = [
  '--ignore-certificate-errors',
  '--allow-insecure-localhost',
  '--test-type'
];

function assertNoBroadTlsBypasses(args) {
  for (const bypass of BROAD_TLS_BYPASSES) {
    assert.equal(args.includes(bypass), false, `${bypass} must not be present`);
  }
}

test('isolated Chromium browsers use only SPKI-scoped trust with their managed profile', () => {
  const browsers = [
    ['chrome', 'Chrome'],
    ['edge', 'Edge'],
    ['brave', 'Brave']
  ];

  for (const [browserType, name] of browsers) {
    const interceptor = new BrowserInterceptor(browserType, name, browserType);
    interceptor.profileDir = `/profiles/${browserType}`;
    interceptor.ca = {
      systemTrustInstalled: false,
      getSpkiFingerprint: () => `${browserType}-spki`
    };

    const args = interceptor._getChromiumArgs(8080, { url: 'https://example.test/' });

    assert.deepEqual(args, [
      '--proxy-server=127.0.0.1:8080',
      '--proxy-bypass-list=<-loopback>',
      `--user-data-dir=/profiles/${browserType}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--ignore-certificate-errors-spki-list=${browserType}-spki`,
      'https://example.test/'
    ]);
    assertNoBroadTlsBypasses(args);
  }
});

test('system-trusted isolated Chromium browsers use no certificate bypass switches', () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  interceptor.profileDir = '/profiles/chrome';
  interceptor.ca = { systemTrustInstalled: true };

  const args = interceptor._getChromiumArgs(8080, {});

  assert.equal(args.some(arg => arg.startsWith('--ignore-certificate-errors')), false);
  assertNoBroadTlsBypasses(args);
  assert.ok(args.includes('--user-data-dir=/profiles/chrome'));
});

test('Global Chrome rejects untrusted CA activation before browser inspection or launch', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor.ca = { systemTrustInstalled: false };
  let browserLookups = 0;
  let processChecks = 0;
  let spawns = 0;
  interceptor._findBrowserPath = () => {
    browserLookups += 1;
    return '/browsers/chrome';
  };
  interceptor._isBrowserRunning = async () => {
    processChecks += 1;
    return false;
  };
  interceptor._spawn = () => {
    spawns += 1;
    assert.fail('untrusted Global Chrome must not spawn');
  };

  assert.equal(await interceptor.isActivable(), false);
  await assert.rejects(
    interceptor.activate(8080),
    /requires the HTTP FreeKit CA to be installed in the system trust store/
  );
  assert.equal(browserLookups, 0);
  assert.equal(processChecks, 0);
  assert.equal(spawns, 0);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('Global Chrome availability still requires its executable when system trust exists', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor.ca = { systemTrustInstalled: true };
  interceptor._findBrowserPath = () => null;

  assert.equal(await interceptor.isActivable(), false);

  interceptor._findBrowserPath = () => '/browsers/chrome';
  assert.equal(await interceptor.isActivable(), true);
});

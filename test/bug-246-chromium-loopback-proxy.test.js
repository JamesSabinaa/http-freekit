import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserInterceptor } from '../src/interceptors/browser-interceptor.js';
import { ensureChromiumLoopbackProxying } from '../src/interceptors/chromium-proxy-args.js';
import { ExistingBrowserInterceptor } from '../src/interceptors/existing-browser-interceptor.js';

const LOOPBACK_OVERRIDE = '--proxy-bypass-list=<-loopback>';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('isolated Chrome, Edge, and Brave launch with one literal loopback override', async () => {
  const browsers = [
    ['chrome', 'Chrome'],
    ['edge', 'Edge'],
    ['brave', 'Brave']
  ];
  let nextPid = 8101;

  for (const [browserType, name] of browsers) {
    const interceptor = new BrowserInterceptor(browserType, name, browserType);
    const profileDir = `/profiles/${browserType} & dev`;
    let launch;
    interceptor._findBrowserPath = () => `/browsers/${browserType}`;
    interceptor._createManagedProfile = () => profileDir;
    interceptor._platform = () => 'win32';
    interceptor._spawn = (browserPath, args, options) => {
      launch = { browserPath, args, options };
      return fakeChild(nextPid++);
    };
    interceptor.ca = { systemTrustInstalled: true };

    await interceptor.activate(8080, { url: 'http://localhost:3000/dev' });

    assert.equal(launch.browserPath, `/browsers/${browserType}`);
    assert.deepEqual(launch.args, [
      '--proxy-server=127.0.0.1:8080',
      LOOPBACK_OVERRIDE,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'http://localhost:3000/dev'
    ]);
    assert.equal(launch.args.filter(arg => arg === LOOPBACK_OVERRIDE).length, 1);
    assert.equal(launch.options.shell, undefined);
    assert.equal(interceptor.toJSON().focusable, true);

    interceptor._stopStatusMonitor();
    interceptor._resetLifecycleState();
  }
});

test('Global Chrome passes the override as one argument without replacing launch flags', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  let launch;
  interceptor._findBrowserPath = () => '/browsers/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = (browserPath, args, options) => {
    launch = { browserPath, args, options };
    return fakeChild(8201);
  };
  interceptor.ca = {
    systemTrustInstalled: false,
    getSpkiFingerprint: () => 'test-spki'
  };

  await interceptor.activate(9090, { url: 'http://127.0.0.1:4000/' });

  assert.deepEqual(launch.args, [
    '--proxy-server=127.0.0.1:9090',
    LOOPBACK_OVERRIDE,
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list=test-spki',
    '--test-type',
    '--allow-insecure-localhost',
    'http://127.0.0.1:4000/'
  ]);
  assert.equal(launch.args.filter(arg => arg === LOOPBACK_OVERRIDE).length, 1);
  assert.equal(launch.args.some(arg => arg.startsWith('--user-data-dir=')), false);
  assert.equal(launch.options.shell, undefined);

  await interceptor.deactivate();
});

test('loopback override merging preserves existing bypass rules and user argument order', () => {
  const original = [
    '--user-flag=first',
    '--proxy-server=127.0.0.1:8080',
    '--proxy-bypass-list=example.test;<-loopback>',
    '--user-flag=second',
    '--proxy-bypass-list=intranet.test;example.test',
    'http://localhost/'
  ];

  const normalized = ensureChromiumLoopbackProxying(original);

  assert.deepEqual(normalized, [
    '--user-flag=first',
    '--proxy-server=127.0.0.1:8080',
    '--proxy-bypass-list=example.test;<-loopback>;intranet.test',
    '--user-flag=second',
    'http://localhost/'
  ]);
  assert.deepEqual(original, [
    '--user-flag=first',
    '--proxy-server=127.0.0.1:8080',
    '--proxy-bypass-list=example.test;<-loopback>',
    '--user-flag=second',
    '--proxy-bypass-list=intranet.test;example.test',
    'http://localhost/'
  ]);
  assert.equal(normalized.filter(arg => arg.startsWith('--proxy-bypass-list=')).length, 1);
});

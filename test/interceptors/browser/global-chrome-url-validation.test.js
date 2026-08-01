import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ExistingBrowserInterceptor } from '../../../src/interceptors/existing-browser-interceptor.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return true;
  };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('Global Chrome rejects unsafe activation URLs before launch-side effects', async () => {
  const unsafeUrls = [
    '--incognito',
    'file:///tmp/private',
    'custom:payload',
    '   ',
    'https://[::1',
    `https://example.com/${'a'.repeat(16 * 1024)}`
  ];

  for (const url of unsafeUrls) {
    const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
    let browserLookups = 0;
    let processChecks = 0;
    let spawns = 0;
    interceptor._findBrowserPath = () => {
      browserLookups += 1;
      return '/test/chrome';
    };
    interceptor._isBrowserRunning = async () => {
      processChecks += 1;
      return false;
    };
    interceptor._spawn = () => {
      spawns += 1;
      return fakeChild(8277);
    };

    await assert.rejects(interceptor.activate(8080, { url }));
    assert.equal(browserLookups, 0, url);
    assert.equal(processChecks, 0, url);
    assert.equal(spawns, 0, url);
    assert.equal(interceptor.active, false, url);
    assert.equal(interceptor.process, null, url);
  }
});

test('Global Chrome can launch without the optional activation URL', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  let launchArgs;
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = (_browserPath, args) => {
    launchArgs = args;
    return fakeChild(8277);
  };
  interceptor.ca = { systemTrustInstalled: true };

  await interceptor.activate(8080);

  assert.deepEqual(launchArgs, [
    '--proxy-server=127.0.0.1:8080',
    '--proxy-bypass-list=<-loopback>'
  ]);

  await interceptor.deactivate();
});

test('Global Chrome launches with one normalized HTTP(S) URL argument', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  let launch;
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = (browserPath, args, options) => {
    launch = { browserPath, args, options };
    return fakeChild(8278);
  };
  interceptor.ca = { systemTrustInstalled: true };

  await interceptor.activate(8080, { url: '  HTTPS://Example.COM/path?q=one two  ' });

  assert.equal(launch.browserPath, '/test/chrome');
  assert.deepEqual(launch.args, [
    '--proxy-server=127.0.0.1:8080',
    '--proxy-bypass-list=<-loopback>',
    'https://example.com/path?q=one%20two'
  ]);
  assert.equal(launch.args.filter(arg => arg === 'https://example.com/path?q=one%20two').length, 1);

  await interceptor.deactivate();
});

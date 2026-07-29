import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserInterceptor } from '../src/interceptors/browser-interceptor.js';

function macBrowser(browserType = 'chrome', name = 'Chrome') {
  const interceptor = new BrowserInterceptor(browserType, name, browserType);
  interceptor._platform = () => 'darwin';
  interceptor.active = true;
  interceptor.profileDir = `/tmp/http-freekit-${browserType}-focus`;
  interceptor.process = { pid: 8201, exitCode: null, signalCode: null };
  interceptor.isActive = async () => true;
  return interceptor;
}

test('macOS Focus activates only a freshly revalidated managed-profile process', async () => {
  const interceptor = macBrowser();
  let inspection;
  interceptor._refreshTrackedProcessIds = async (force, lifecycle) => {
    inspection = { force, lifecycle };
    return new Set([8201, 8202, 8203]);
  };
  let invocation;
  interceptor._execFile = async (command, args, options) => {
    invocation = { command, args, options };
  };

  assert.deepEqual(await interceptor.focus(), { success: true });

  assert.equal(inspection.force, true);
  assert.equal(inspection.lifecycle.profileDir, interceptor.profileDir);
  assert.equal(invocation.command, 'osascript');
  assert.deepEqual(invocation.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.deepEqual(invocation.options, { stdio: 'ignore', timeout: 5000 });
  const script = invocation.args[3];
  assert.match(script, /candidatePids = \[8201,8202,8203\]/);
  assert.match(script, /NSRunningApplication\.runningApplicationWithProcessIdentifier\(pid\)/);
  assert.match(script, /expectedBundleIdentifier = "com\.google\.Chrome"/);
  assert.match(script, /bundleIdentifier !== expectedBundleIdentifier/);
  assert.match(script, /activateWithOptions\(\$\.NSApplicationActivateIgnoringOtherApps\)/);
  assert.doesNotMatch(script, /tell application|Google Chrome.*activate/);
});

test('macOS Focus fails closed when managed-profile process inspection is unavailable', async () => {
  const interceptor = macBrowser();
  interceptor._refreshTrackedProcessIds = async force => {
    assert.equal(force, true);
    return null;
  };
  interceptor._execFile = async () => assert.fail('generic application activation must not be attempted');

  await assert.rejects(
    interceptor.focus(),
    /Could not safely identify the managed Chrome process to focus/
  );
});

test('macOS Focus rejects an empty managed-profile process set', async () => {
  const interceptor = macBrowser();
  interceptor._refreshTrackedProcessIds = async () => new Set();
  interceptor._execFile = async () => assert.fail('no application should be activated');

  await assert.rejects(
    interceptor.focus(),
    /Could not find the managed Chrome application process to focus/
  );
});

test('macOS Focus pins each supported isolated browser to its exact bundle identifier', async () => {
  const browserBundles = {
    chrome: 'com.google.Chrome',
    firefox: 'org.mozilla.firefox',
    edge: 'com.microsoft.edgemac',
    brave: 'com.brave.Browser'
  };

  for (const [browserType, bundleIdentifier] of Object.entries(browserBundles)) {
    const interceptor = macBrowser(browserType, browserType);
    interceptor._refreshTrackedProcessIds = async () => new Set([8301]);
    let script;
    interceptor._execFile = async (_command, args) => { script = args[3]; };

    await interceptor.focus();

    assert.ok(script.includes(JSON.stringify(bundleIdentifier)));
  }
});

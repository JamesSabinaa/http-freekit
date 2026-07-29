import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { BrowserInterceptor } from '../src/interceptors/browser-interceptor.js';

function macBrowser(browserType = 'chrome', name = 'Chrome') {
  const interceptor = new BrowserInterceptor(browserType, name, browserType);
  interceptor._platform = () => 'darwin';
  interceptor.active = true;
  interceptor.profileDir = `/tmp/http-freekit-${browserType}-focus`;
  interceptor.process = { pid: 8201, exitCode: null, signalCode: null };
  interceptor.isActive = async () => true;
  interceptor._isSpawnedProcessRunning = () => true;
  return interceptor;
}

test('macOS Focus activates only a freshly revalidated managed-profile process', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => [
    { pid: 8201, ppid: 1, startedAt: 1785300000123, command: 'chrome managed' },
    { pid: 8202, ppid: 8201, startedAt: 1785300001123, command: 'chrome helper' },
    { pid: 8203, ppid: 8202, startedAt: 1785300002123, command: 'chrome helper child' }
  ];
  let invocation;
  interceptor._execFile = async (command, args, options) => {
    invocation = { command, args, options };
  };

  assert.deepEqual(await interceptor.focus(), { success: true });

  assert.deepEqual([...interceptor.trackedProcessIds], [8201, 8202, 8203]);
  assert.equal(invocation.command, 'osascript');
  assert.deepEqual(invocation.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.deepEqual(invocation.options, { stdio: 'ignore', timeout: 5000 });
  const script = invocation.args[3];
  assert.match(script, /candidateProcesses = \[\{"pid":8201,"startedAt":1785300000123\}/);
  assert.match(script, /NSRunningApplication\.runningApplicationWithProcessIdentifier\(candidate\.pid\)/);
  assert.match(script, /expectedBundleIdentifier = "com\.google\.Chrome"/);
  assert.match(script, /bundleIdentifier !== expectedBundleIdentifier/);
  assert.match(script, /launchDate\.timeIntervalSince1970/);
  assert.match(script, /Math\.floor\(launchTime \/ 1000\) !== Math\.floor\(candidate\.startedAt \/ 1000\)/);
  assert.match(script, /activateWithOptions\(\$\.NSApplicationActivateIgnoringOtherApps\)/);
  assert.doesNotMatch(script, /tell application|Google Chrome.*activate/);
});

test('macOS Focus fails closed when managed-profile process inspection is unavailable', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => { throw new Error('ps denied'); };
  interceptor._execFile = async () => assert.fail('generic application activation must not be attempted');

  await assert.rejects(
    interceptor.focus(),
    /Could not safely identify the managed Chrome process to focus/
  );
});

test('macOS Focus rejects an empty managed-profile process set', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => [];
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
    interceptor.process.pid = 8301;
    interceptor._getProcessSnapshot = async () => [
      { pid: 8301, ppid: 1, startedAt: 1785300010000, command: browserType }
    ];
    let script;
    interceptor._execFile = async (_command, args) => { script = args[3]; };

    await interceptor.focus();

    assert.ok(script.includes(JSON.stringify(bundleIdentifier)));
  }
});

test('macOS Focus omits managed PIDs without a verifiable process generation', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => [
    { pid: 8201, ppid: 1, startedAt: null, command: 'chrome managed' }
  ];
  interceptor._execFile = async () => assert.fail('an unversioned PID must never reach AppKit');

  await assert.rejects(
    interceptor.focus(),
    /Could not find the managed Chrome application process to focus/
  );
});

test('macOS AppKit handoff rejects a recycled same-bundle PID by launch time', async () => {
  const interceptor = macBrowser();
  const startedAt = 1785300020123;
  interceptor._getProcessSnapshot = async () => [
    { pid: 8201, ppid: 1, startedAt, command: 'chrome managed' }
  ];
  let script;
  interceptor._execFile = async (_command, args) => { script = args[3]; };
  await interceptor.focus();

  const runHandoff = launchTime => {
    let activations = 0;
    const app = {
      bundleIdentifier: 'com.google.Chrome',
      launchDate: { timeIntervalSince1970: launchTime / 1000 },
      activateWithOptions() {
        activations += 1;
        return true;
      }
    };
    const context = {
      ObjC: { import() {}, unwrap: value => value },
      $: {
        NSApplicationActivateIgnoringOtherApps: 1,
        NSRunningApplication: {
          runningApplicationWithProcessIdentifier: pid => pid === 8201 ? app : null
        }
      }
    };
    return {
      execute: () => vm.runInNewContext(script, context),
      getActivations: () => activations
    };
  };

  const exactGeneration = runHandoff(startedAt + 400);
  assert.doesNotThrow(exactGeneration.execute);
  assert.equal(exactGeneration.getActivations(), 1);

  const recycledGeneration = runHandoff(startedAt + 5000);
  assert.throws(recycledGeneration.execute, /No matching managed browser application/);
  assert.equal(recycledGeneration.getActivations(), 0);
});

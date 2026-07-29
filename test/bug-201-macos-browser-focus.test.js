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

function managedProfileCommand(interceptor) {
  if (interceptor.browserType === 'firefox') {
    return `/Applications/Firefox.app/Contents/MacOS/firefox -profile ${interceptor.profileDir}`;
  }
  const executable = {
    chrome: 'Google Chrome',
    edge: 'Microsoft Edge',
    brave: 'Brave Browser'
  }[interceptor.browserType];
  return `/Applications/${executable}.app/Contents/MacOS/${executable} ` +
    `--user-data-dir=${interceptor.profileDir}`;
}

function managedCommandName(interceptor) {
  return {
    chrome: 'Google Chrome',
    firefox: 'firefox',
    edge: 'Microsoft Edge',
    brave: 'Brave Browser'
  }[interceptor.browserType];
}

test('macOS isolated browsers launch through LaunchServices with their exact arguments', () => {
  const interceptor = macBrowser();
  const invocation = interceptor._getLaunchInvocation(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--user-data-dir=/tmp/http-freekit-chrome-focus', '--no-first-run']
  );

  assert.deepEqual(invocation, {
    command: '/usr/bin/open',
    args: [
      '-W',
      '-n',
      '-a',
      '/Applications/Google Chrome.app',
      '--args',
      '--user-data-dir=/tmp/http-freekit-chrome-focus',
      '--no-first-run'
    ]
  });
  assert.throws(
    () => interceptor._getLaunchInvocation('/usr/local/bin/google-chrome', []),
    /Could not resolve the Chrome macOS application bundle/
  );
});

test('macOS Focus activates only a freshly revalidated managed-profile process', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => [
    {
      pid: 8201,
      ppid: 1,
      startedAt: 1785300000123,
      commandName: managedCommandName(interceptor),
      command: managedProfileCommand(interceptor)
    },
    { pid: 8202, ppid: 8201, startedAt: 1785300001123, command: 'chrome helper' },
    { pid: 8203, ppid: 8202, startedAt: 1785300002123, command: 'chrome helper child' }
  ];
  const invocations = [];
  interceptor._execFile = async (command, args, options) => {
    invocations.push({ command, args, options });
    if (args[3].includes('observedApplications')) {
      return JSON.stringify([{ pid: 8201, launchTime: 1785300000.123 }]);
    }
  };

  assert.deepEqual(await interceptor.focus(), { success: true });

  assert.deepEqual([...interceptor.trackedProcessIds], [8201, 8202, 8203]);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].command, 'osascript');
  assert.deepEqual(invocations[0].options, { encoding: 'utf8', timeout: 5000 });
  assert.deepEqual(invocations[1].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.deepEqual(invocations[1].options, { stdio: 'ignore', timeout: 5000 });
  const observationScript = invocations[0].args[3];
  const script = invocations[1].args[3];
  assert.match(observationScript, /candidateProcesses = \[\{"pid":8201,"startedAt":1785300000123\}/);
  assert.match(observationScript, /observedApplications\.push\(\{ pid: candidate\.pid, launchTime \}\)/);
  assert.match(script, /candidateProcesses = \[\{"pid":8201,"launchTime":1785300000\.123\}\]/);
  assert.match(script, /NSRunningApplication\.runningApplicationWithProcessIdentifier\(candidate\.pid\)/);
  assert.match(script, /expectedBundleIdentifier = "com\.google\.Chrome"/);
  assert.match(script, /bundleIdentifier !== expectedBundleIdentifier/);
  assert.match(script, /launchDate\.timeIntervalSince1970/);
  assert.match(script, /launchTime !== candidate\.launchTime/);
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
  assert.equal(interceptor.lastProcessInspectionFailed, true);
  assert.equal(interceptor.lifecycleInspectionErrorLogged, true);
});

test('macOS Stop preserves ownership when profile process arguments are ambiguous', async () => {
  const interceptor = macBrowser();
  const profileDir = interceptor.profileDir;
  const signalled = [];
  interceptor._getRelatedProcessIds = async () => {
    const error = new Error('Browser profile process arguments are ambiguous');
    error.code = 'AMBIGUOUS_BROWSER_PROFILE_PROCESS';
    throw error;
  };
  interceptor._signalProcesses = processIds => signalled.push([...processIds]);
  interceptor._cleanup = () => assert.fail('an ambiguous live profile must not be removed');

  await assert.rejects(
    interceptor.deactivate(),
    /Could not fully stop Chrome/
  );

  assert.deepEqual(signalled, [[8201]]);
  assert.equal(interceptor.profileDir, profileDir);
  assert.equal(interceptor.cleanupPending, true);
  assert.equal(interceptor.active, true);
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
      {
        pid: 8301,
        ppid: 1,
        startedAt: 1785300010000,
        commandName: managedCommandName(interceptor),
        command: managedProfileCommand(interceptor)
      }
    ];
    let script;
    interceptor._execFile = async (_command, args) => {
      if (args[3].includes('observedApplications')) {
        return JSON.stringify([{ pid: 8301, launchTime: 1785300010 }]);
      }
      script = args[3];
    };

    await interceptor.focus();

    assert.ok(script.includes(JSON.stringify(bundleIdentifier)));
  }
});

test('macOS Focus omits managed PIDs without a verifiable process generation', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => [
    {
      pid: 8201,
      ppid: 1,
      startedAt: null,
      commandName: managedCommandName(interceptor),
      command: managedProfileCommand(interceptor)
    }
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
    {
      pid: 8201,
      ppid: 1,
      startedAt,
      commandName: managedCommandName(interceptor),
      command: managedProfileCommand(interceptor)
    }
  ];
  let script;
  const observedLaunchTime = startedAt / 1000;
  interceptor._execFile = async (_command, args) => {
    if (args[3].includes('observedApplications')) {
      return JSON.stringify([{ pid: 8201, launchTime: observedLaunchTime }]);
    }
    script = args[3];
  };
  await interceptor.focus();

  const runHandoff = launchTime => {
    let activations = 0;
    const app = {
      bundleIdentifier: 'com.google.Chrome',
      launchDate: { timeIntervalSince1970: launchTime },
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

  const exactGeneration = runHandoff(observedLaunchTime);
  assert.doesNotThrow(exactGeneration.execute);
  assert.equal(exactGeneration.getActivations(), 1);

  const recycledGeneration = runHandoff(observedLaunchTime + 0.4);
  assert.throws(recycledGeneration.execute, /No matching managed browser application/);
  assert.equal(recycledGeneration.getActivations(), 0);
});

test('macOS Focus rejects a live launcher PID recycled by a default-profile browser', async () => {
  const interceptor = macBrowser();
  interceptor._getProcessSnapshot = async () => [
    {
      pid: 8201,
      ppid: 1,
      startedAt: 1785300030000,
      commandName: managedCommandName(interceptor),
      command: 'chrome --profile-directory=Default'
    },
    { pid: 8202, ppid: 8201, startedAt: 1785300030100, command: 'chrome helper' }
  ];
  interceptor._execFile = async () => assert.fail('a recycled launcher tree must not reach AppKit');

  await assert.rejects(
    interceptor.focus(),
    /Could not find the managed Chrome application process to focus/
  );
  assert.deepEqual([...interceptor.trackedProcessIds], []);
});

test('macOS Focus rejects a same-second profile swap between identity observation and activation', async () => {
  const interceptor = macBrowser();
  let snapshots = 0;
  interceptor._getProcessSnapshot = async () => {
    snapshots++;
    return snapshots === 1
      ? [{
          pid: 8201,
          ppid: 1,
          startedAt: 1785300035000,
          commandName: managedCommandName(interceptor),
          command: managedProfileCommand(interceptor)
        }]
      : [{
          pid: 8201,
          ppid: 1,
          startedAt: 1785300035400,
          commandName: managedCommandName(interceptor),
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ' +
            '--profile-directory=Default'
        }];
  };
  let appKitCalls = 0;
  interceptor._execFile = async (_command, args) => {
    appKitCalls++;
    if (args[3].includes('observedApplications')) {
      return JSON.stringify([{ pid: 8201, launchTime: 1785300035 }]);
    }
    assert.fail('a revalidated default-profile process must not be activated');
  };

  await assert.rejects(
    interceptor.focus(),
    /Could not find the managed Chrome application process to focus/
  );
  assert.equal(snapshots, 2);
  assert.equal(appKitCalls, 1);
  assert.deepEqual([...interceptor.trackedProcessIds], []);
});

test('successful macOS Focus resets prior inspection failure bookkeeping', async () => {
  const interceptor = macBrowser();
  interceptor.lastProcessInspectionFailed = true;
  interceptor.lifecycleInspectionErrorLogged = true;
  interceptor._getProcessSnapshot = async () => [{
    pid: 8201,
    ppid: 1,
    startedAt: 1785300040000,
    commandName: managedCommandName(interceptor),
    command: managedProfileCommand(interceptor)
  }];
  interceptor._execFile = async (_command, args) => args[3].includes('observedApplications')
    ? JSON.stringify([{ pid: 8201, launchTime: 1785300040 }])
    : '';

  await interceptor.focus();

  assert.equal(interceptor.lastProcessInspectionFailed, false);
  assert.equal(interceptor.lifecycleInspectionErrorLogged, false);
});

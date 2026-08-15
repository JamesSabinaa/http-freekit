import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';
import { PROCESS_STARTUP_EXIT_ERROR_CODE } from '../../../src/interceptors/command-runner.js';

const launchPaths = [
  {
    name: 'current profile executable path',
    recovered: false,
    browserPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    profileDir: 'C:\\Temp\\http-freekit-chrome-current'
  },
  {
    name: 'recovered macOS profile executable path',
    recovered: true,
    browserPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    profileDir: '/tmp/http-freekit-chrome-recovered'
  }
];

function fakeChild(pid = 8101) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  return child;
}

async function beginOpen(launchPath, child, confirmationMs = 50) {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  interceptor.ca = { systemTrustInstalled: true };
  interceptor.openUrlConfirmationMs = confirmationMs;
  interceptor._findBrowserPath = () => launchPath.browserPath;
  interceptor.isActive = async () => true;

  if (launchPath.recovered) {
    interceptor.recoveredProfiles.set(launchPath.profileDir, {
      profileDir: launchPath.profileDir,
      processIds: new Set([8001]),
      proxyPort: 8181,
      running: true
    });
  } else {
    interceptor.active = true;
    interceptor.profileDir = launchPath.profileDir;
    interceptor.proxyPort = 8181;
  }

  let spawned;
  const spawnCalled = new Promise(resolve => { spawned = resolve; });
  let invocation;
  interceptor._spawn = (command, args, options) => {
    invocation = { command, args, options };
    spawned();
    return child;
  };

  const url = 'https://example.com/open-confirmation';
  const opening = interceptor.openUrl(url);
  await spawnCalled;
  assert.equal(invocation.command, launchPath.browserPath);
  assert.deepEqual(invocation.options, { detached: false, stdio: 'ignore' });
  assert.equal(invocation.args.at(-1), url);
  assert.ok(invocation.args.includes(`--user-data-dir=${launchPath.profileDir}`));
  return { opening, url };
}

function assertNoConfirmationListeners(child) {
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
}

test('Open rejects a real exit 9 queued behind a stalled event loop', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  interceptor.ca = { systemTrustInstalled: true };
  interceptor.active = true;
  interceptor.profileDir = 'test-profile';
  interceptor.proxyPort = 8181;
  interceptor.isActive = async () => true;
  interceptor._findBrowserPath = () => process.execPath;

  const opening = interceptor.openUrl('https://example.com/immediate-exit');
  setImmediate(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
  });

  await assert.rejects(
    opening,
    error => {
      assert.equal(error.code, PROCESS_STARTUP_EXIT_ERROR_CODE);
      assert.equal(error.exitCode, 9);
      assert.equal(error.signal, null);
      return true;
    }
  );
});

for (const launchPath of launchPaths) {
  test(`Open rejects an immediate exit 9 from the ${launchPath.name}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const { opening } = await beginOpen(launchPath, child);
    const rejection = assert.rejects(opening, error => {
      assert.equal(error.code, PROCESS_STARTUP_EXIT_ERROR_CODE);
      assert.equal(error.exitCode, 9);
      assert.equal(error.signal, null);
      assert.match(error.message, /Chrome URL opener exited during startup \(exit code 9\)/);
      return true;
    });

    child.emit('spawn');
    child.exitCode = 9;
    child.emit('exit', 9, null);

    await rejection;
    assert.equal(child.unrefCalls, 0);
    assertNoConfirmationListeners(child);
  });

  test(`Open accepts an immediate zero exit from the ${launchPath.name}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const { opening, url } = await beginOpen(launchPath, child);

    child.emit('spawn');
    child.exitCode = 0;
    child.emit('exit', 0, null);

    assert.deepEqual(await opening, { success: true, browser: 'Chrome', url });
    assert.equal(child.unrefCalls, 1);
    assertNoConfirmationListeners(child);
  });

  test(`Open bounds confirmation and unreferences a long-lived ${launchPath.name}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const { opening, url } = await beginOpen(launchPath, child);

    child.emit('spawn');
    assert.equal(child.unrefCalls, 0, 'the opener must remain referenced during confirmation');
    t.mock.timers.tick(50);

    assert.deepEqual(await opening, { success: true, browser: 'Chrome', url });
    assert.equal(child.unrefCalls, 1);
    assertNoConfirmationListeners(child);
  });

  test(`Open propagates a spawn error from the ${launchPath.name}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const spawnError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const { opening } = await beginOpen(launchPath, child);
    const rejection = assert.rejects(opening, error => error === spawnError);

    child.emit('error', spawnError);

    await rejection;
    assert.equal(child.unrefCalls, 0);
    assertNoConfirmationListeners(child);
  });

  test(`Open observes an exit status racing the ${launchPath.name} confirmation timer`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const { opening } = await beginOpen(launchPath, child);
    const rejection = assert.rejects(opening, error => {
      assert.equal(error.code, PROCESS_STARTUP_EXIT_ERROR_CODE);
      assert.equal(error.exitCode, 9);
      return true;
    });

    child.emit('spawn');
    // Model an OS exit status becoming visible just before the timer callback,
    // while delivery of the corresponding EventEmitter event is still queued.
    child.exitCode = 9;
    t.mock.timers.tick(50);

    await rejection;
    assert.equal(child.unrefCalls, 0);
    assertNoConfirmationListeners(child);
  });
}

test('Open confirmation handles pre-spawn and post-deadline exit event races', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const preSpawnChild = fakeChild(8201);
  const preSpawnLaunch = await beginOpen(launchPaths[0], preSpawnChild);
  const preSpawnRejection = assert.rejects(
    preSpawnLaunch.opening,
    error => error.code === PROCESS_STARTUP_EXIT_ERROR_CODE && error.exitCode === 9
  );

  preSpawnChild.exitCode = 9;
  preSpawnChild.emit('exit', 9, null);
  preSpawnChild.emit('spawn');
  await preSpawnRejection;
  assertNoConfirmationListeners(preSpawnChild);

  const postDeadlineChild = fakeChild(8202);
  const postDeadlineLaunch = await beginOpen(launchPaths[1], postDeadlineChild);
  postDeadlineChild.emit('spawn');
  t.mock.timers.tick(50);
  assert.deepEqual(await postDeadlineLaunch.opening, {
    success: true,
    browser: 'Chrome',
    url: postDeadlineLaunch.url
  });
  assertNoConfirmationListeners(postDeadlineChild);

  postDeadlineChild.exitCode = 9;
  postDeadlineChild.emit('exit', 9, null);
  assert.equal(postDeadlineChild.unrefCalls, 1);
  assertNoConfirmationListeners(postDeadlineChild);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';
import {
  cleanupStaleBrowserProfiles,
  collectRelatedProcessIds,
  createManagedBrowserProfile,
  inspectManagedProfilePath,
  removeManagedBrowserProfile
} from '../../../src/interceptors/browser-lifecycle.js';

test('collects profile processes and their complete descendant trees', () => {
  const profileDir = path.join(os.tmpdir(), 'http-freekit-chrome-tree-test');
  const rows = [
    { pid: 101, ppid: 1, command: `chrome --user-data-dir=${profileDir}` },
    { pid: 102, ppid: 101, command: 'chrome --type=gpu-process' },
    { pid: 103, ppid: 102, command: 'chrome --type=renderer' },
    { pid: 201, ppid: 1, command: 'explicit browser launcher' },
    { pid: 202, ppid: 201, command: 'launcher child without profile argument' },
    { pid: 999, ppid: 1, command: 'unrelated-process' }
  ];

  assert.deepEqual(
    [...collectRelatedProcessIds(rows, profileDir, [201])].sort((a, b) => a - b),
    [101, 102, 103, 201, 202]
  );
});

test('only recognizes managed profile directories directly inside the chosen temp root', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-lifecycle-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const managed = createManagedBrowserProfile('chrome', tempRoot);
  const nested = path.join(managed, 'http-freekit-chrome-nested');
  fs.mkdirSync(nested);
  const unrelated = path.join(tempRoot, 'unrelated-profile');
  fs.mkdirSync(unrelated);

  assert.equal(inspectManagedProfilePath(managed, tempRoot).safe, true);
  assert.equal(inspectManagedProfilePath(nested, tempRoot).safe, false);
  assert.equal(inspectManagedProfilePath(unrelated, tempRoot).safe, false);
});

test('startup cleanup removes abandoned profiles and preserves active or unrelated directories', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-stale-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const liveOwnerProfile = createManagedBrowserProfile('chrome', tempRoot);
  const liveOwnerMarker = JSON.parse(fs.readFileSync(
    path.join(liveOwnerProfile, '.http-freekit-profile.json'),
    'utf8'
  ));
  const staleOwnedProfile = createManagedBrowserProfile('firefox', tempRoot);
  const staleOwnerMarker = JSON.parse(fs.readFileSync(
    path.join(staleOwnedProfile, '.http-freekit-profile.json'),
    'utf8'
  ));
  fs.writeFileSync(
    path.join(staleOwnedProfile, '.http-freekit-profile.json'),
    JSON.stringify({ ...staleOwnerMarker, ownerPid: 2147483647 })
  );
  const legacyStaleProfile = path.join(tempRoot, 'http-freekit-edge-1700000000000');
  fs.mkdirSync(legacyStaleProfile);
  const activeBrowserProfile = createManagedBrowserProfile('brave', tempRoot);
  const unrelated = path.join(tempRoot, 'other-application-data');
  fs.mkdirSync(unrelated);

  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshot: [{
      pid: process.pid,
      ppid: 1,
      startedAt: Date.parse(liveOwnerMarker.ownerStartedAt),
      command: process.execPath
    }, {
      pid: 4242,
      ppid: 1,
      startedAt: Date.now(),
      command: `brave --user-data-dir=${activeBrowserProfile}`
    }]
  });

  assert.deepEqual(
    result.removed.map(item => path.basename(item)).sort(),
    [path.basename(staleOwnedProfile)]
  );
  assert.deepEqual(result.skippedActive.map(item => path.basename(item)).sort(), [
    path.basename(activeBrowserProfile),
    path.basename(liveOwnerProfile)
  ].sort());
  assert.match(
    result.failed.find(item => item.path === legacyStaleProfile)?.reason || '',
    /missing .*ownership marker/
  );
  assert.equal(fs.existsSync(staleOwnedProfile), false);
  assert.equal(fs.existsSync(legacyStaleProfile), true);
  assert.equal(fs.existsSync(liveOwnerProfile), true);
  assert.equal(fs.existsSync(activeBrowserProfile), true);
  assert.equal(fs.existsSync(unrelated), true);
});

test('startup cleanup does not trust an owner PID reused after profile creation', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-reused-pid-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const profileDir = createManagedBrowserProfile('chrome', tempRoot);
  fs.writeFileSync(
    path.join(profileDir, '.http-freekit-profile.json'),
    JSON.stringify({
      ownerPid: process.pid,
      ownerStartedAt: '1999-12-31T23:59:00.000Z',
      browserType: 'chrome',
      createdAt: '2000-01-01T00:00:00.000Z'
    })
  );

  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshot: [{
      pid: process.pid,
      ppid: 1,
      startedAt: Date.now(),
      command: 'unrelated-process'
    }]
  });

  assert.deepEqual(result.skippedActive, []);
  assert.deepEqual(result.removed, [profileDir]);
  assert.equal(fs.existsSync(profileDir), false);
});

test('managed profile removal is recursive and refuses an unowned target', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-remove-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const managed = createManagedBrowserProfile('edge', tempRoot);
  fs.mkdirSync(path.join(managed, 'nested'));
  fs.writeFileSync(path.join(managed, 'nested', 'data.txt'), 'test');
  assert.equal(removeManagedBrowserProfile(managed, { tempDir: tempRoot }).removed, true);
  assert.equal(fs.existsSync(managed), false);

  const unrelated = path.join(tempRoot, 'keep-me');
  fs.mkdirSync(unrelated);
  const refused = removeManagedBrowserProfile(unrelated, { tempDir: tempRoot });
  assert.equal(refused.removed, false);
  assert.equal(refused.unsafe, true);
  assert.equal(fs.existsSync(unrelated), true);
});

test('deactivation terminates every resolved PID before removing and resetting the profile', async (t) => {
  const profileDir = createManagedBrowserProfile('chrome');
  t.after(() => rm(profileDir, { recursive: true, force: true }));

  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  interceptor.active = true;
  interceptor.profileDir = profileDir;
  interceptor.process = { pid: 5101 };
  interceptor.trackedProcessIds = new Set([5101]);
  interceptor._isSpawnedProcessRunning = () => true;
  interceptor._refreshTrackedProcessIds = () => new Set([5101, 5102, 5103]);
  let terminationTargets;
  interceptor._terminateProcessTree = async targets => {
    terminationTargets = [...targets].sort((a, b) => a - b);
    return new Set();
  };
  let statusEvent;
  interceptor.onStatusChange = event => { statusEvent = event; };

  await interceptor.deactivate();

  assert.deepEqual(terminationTargets, [5101, 5102, 5103]);
  assert.equal(fs.existsSync(profileDir), false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.profileDir, null);
  assert.equal(interceptor.trackedProcessIds.size, 0);
  assert.equal(statusEvent.profileRemoved, true);
  assert.equal(statusEvent.remainingProcessCount, 0);
});

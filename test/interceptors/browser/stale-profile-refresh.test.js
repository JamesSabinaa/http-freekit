import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupStaleBrowserProfiles,
  createManagedBrowserProfile
} from '../../../src/interceptors/browser-lifecycle.js';

const PROFILE_MARKER = '.http-freekit-profile.json';

function markerPath(profileDir) {
  return path.join(profileDir, PROFILE_MARKER);
}

function rewriteOwner(profileDir, {
  ownerPid,
  ownerStartedAt = '2000-01-01T00:00:00.000Z',
  createdAt = '2000-01-01T00:00:01.000Z'
}) {
  const marker = JSON.parse(fs.readFileSync(markerPath(profileDir), 'utf8'));
  fs.writeFileSync(markerPath(profileDir), JSON.stringify({
    ...marker,
    ownerPid,
    ownerStartedAt,
    createdAt
  }));
}

async function createTempRoot(t, label) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `http-freekit-${label}-`));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function failureFor(result, profileDir) {
  return result.failed.find(item => item.path === profileDir)?.reason || '';
}

test('candidate enumeration precedes the initial process snapshot', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-enumeration-race');
  const staleProfile = createManagedBrowserProfile('firefox', tempRoot);
  rewriteOwner(staleProfile, { ownerPid: 2147483601 });

  let concurrentlyCreatedProfile = null;
  let snapshotCalls = 0;
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      if (snapshotCalls === 1) {
        concurrentlyCreatedProfile = createManagedBrowserProfile('chrome', tempRoot);
        rewriteOwner(concurrentlyCreatedProfile, { ownerPid: 41001 });
      }
      return [];
    }
  });

  assert.equal(snapshotCalls, 2, 'one post-enumeration snapshot plus one stale-candidate refresh');
  assert.deepEqual(result.removed, [staleProfile]);
  assert.ok(concurrentlyCreatedProfile);
  assert.equal(fs.existsSync(concurrentlyCreatedProfile), true);
  assert.equal(result.removed.includes(concurrentlyCreatedProfile), false);
  assert.equal(result.failed.some(item => item.path === concurrentlyCreatedProfile), false);
});

test('a fresh pre-delete snapshot preserves a newly active profile owner', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-owner-race');
  const profileDir = createManagedBrowserProfile('chrome', tempRoot);
  const ownerStartedAt = '2024-01-02T03:04:05.000Z';
  rewriteOwner(profileDir, { ownerPid: 41002, ownerStartedAt });

  let snapshotCalls = 0;
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      return snapshotCalls === 1 ? [] : [{
        pid: 41002,
        ppid: 1,
        startedAt: Date.parse(ownerStartedAt),
        command: 'http-freekit-server'
      }];
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedActive, [profileDir]);
  assert.equal(fs.existsSync(profileDir), true);
});

test('a fresh pre-delete snapshot preserves a newly related browser process', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-browser-race');
  const profileDir = createManagedBrowserProfile('brave', tempRoot);
  rewriteOwner(profileDir, { ownerPid: 2147483602 });

  let snapshotCalls = 0;
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      return snapshotCalls === 1 ? [] : [{
        pid: 41003,
        ppid: 1,
        startedAt: Date.now(),
        command: `brave --user-data-dir=${profileDir}`
      }];
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedActive, [profileDir]);
  assert.equal(fs.existsSync(profileDir), true);
});

test('ownership changes during the fresh snapshot fail closed', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-owner-revalidation');
  const profileDir = createManagedBrowserProfile('chrome', tempRoot);
  rewriteOwner(profileDir, { ownerPid: 2147483606 });

  let snapshotCalls = 0;
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      if (snapshotCalls === 2) {
        rewriteOwner(profileDir, {
          ownerPid: 41006,
          ownerStartedAt: '2024-02-03T04:05:06.000Z',
          createdAt: '2024-02-03T04:05:07.000Z'
        });
        return [{
          pid: 41006,
          ppid: 1,
          startedAt: Date.parse('2024-02-03T04:05:06.000Z'),
          command: 'http-freekit-server'
        }];
      }
      return [];
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedActive, []);
  assert.match(failureFor(result, profileDir), /ownership changed during cleanup revalidation/);
  assert.equal(fs.existsSync(profileDir), true);
});

test('a process snapshot refresh failure fails closed and preserves the profile', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-refresh-failure');
  const profileDir = createManagedBrowserProfile('edge', tempRoot);
  rewriteOwner(profileDir, { ownerPid: 2147483603 });

  let snapshotCalls = 0;
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      if (snapshotCalls === 2) throw new Error('process inspection unavailable');
      return [];
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedActive, []);
  assert.match(failureFor(result, profileDir), /process inspection unavailable/);
  assert.equal(fs.existsSync(profileDir), true);
});

test('a profile still stale in the fresh snapshot is removed', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-confirmed-stale');
  const profileDir = createManagedBrowserProfile('firefox', tempRoot);
  rewriteOwner(profileDir, { ownerPid: 2147483604 });

  let snapshotCalls = 0;
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      return [];
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.deepEqual(result.removed, [profileDir]);
  assert.deepEqual(result.skippedActive, []);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(profileDir), false);
});

test('fresh PID-start validation still removes an owner PID reused by another process', async t => {
  const tempRoot = await createTempRoot(t, 'cleanup-pid-reuse');
  const profileDir = createManagedBrowserProfile('chrome', tempRoot);
  rewriteOwner(profileDir, {
    ownerPid: 41005,
    ownerStartedAt: '2000-01-01T00:00:00.000Z',
    createdAt: '2000-01-01T00:00:01.000Z'
  });

  let snapshotCalls = 0;
  const reusedPidSnapshot = [{
    pid: 41005,
    ppid: 1,
    startedAt: Date.parse('2025-01-01T00:00:00.000Z'),
    command: 'unrelated-process'
  }];
  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshotProvider: () => {
      snapshotCalls++;
      return reusedPidSnapshot;
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.deepEqual(result.skippedActive, []);
  assert.deepEqual(result.removed, [profileDir]);
  assert.equal(fs.existsSync(profileDir), false);
});

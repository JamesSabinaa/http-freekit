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
const STALE_PID = 2147483647;

function markerPath(profileDir) {
  return path.join(profileDir, PROFILE_MARKER);
}

function readMarker(profileDir) {
  return JSON.parse(fs.readFileSync(markerPath(profileDir), 'utf8'));
}

function makeOwnerStale(profileDir) {
  fs.writeFileSync(markerPath(profileDir), JSON.stringify({
    ...readMarker(profileDir),
    ownerPid: STALE_PID
  }));
}

function createLookalike(tempRoot, name) {
  const profileDir = path.join(tempRoot, name);
  fs.mkdirSync(profileDir);
  fs.writeFileSync(path.join(profileDir, 'keep.txt'), 'must survive startup cleanup');
  return profileDir;
}

function failureFor(result, profileDir) {
  return result.failed.find(item => item.path === profileDir)?.reason || '';
}

test('startup cleanup preserves every profile lookalike without a valid regular ownership marker', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-marker-proof-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const markerless = createLookalike(tempRoot, 'http-freekit-chrome-backup');

  const malformedJson = createLookalike(tempRoot, 'http-freekit-firefox-malformed-json');
  fs.writeFileSync(markerPath(malformedJson), '{ definitely not JSON');

  const malformedFields = createLookalike(tempRoot, 'http-freekit-edge-malformed-fields');
  fs.writeFileSync(markerPath(malformedFields), JSON.stringify({
    ownerPid: 'not-a-pid',
    browserType: 'edge',
    createdAt: new Date().toISOString()
  }));

  const nonRegularMarker = createLookalike(tempRoot, 'http-freekit-chrome-marker-directory');
  fs.mkdirSync(markerPath(nonRegularMarker));

  const symlinkMarker = createLookalike(tempRoot, 'http-freekit-brave-marker-symlink');
  const externalMarker = path.join(tempRoot, 'lookalike-marker-target.json');
  fs.writeFileSync(externalMarker, JSON.stringify({
    ownerPid: STALE_PID,
    ownerStartedAt: '2000-01-01T00:00:00.000Z',
    browserType: 'brave',
    createdAt: '2000-01-01T00:00:01.000Z'
  }));
  fs.symlinkSync(externalMarker, markerPath(symlinkMarker), 'file');

  const staleOwned = createManagedBrowserProfile('firefox', tempRoot);
  makeOwnerStale(staleOwned);

  const result = cleanupStaleBrowserProfiles({ tempDir: tempRoot, processSnapshot: [] });

  assert.deepEqual(result.removed, [staleOwned]);
  assert.equal(fs.existsSync(staleOwned), false);
  for (const profileDir of [markerless, malformedJson, malformedFields, nonRegularMarker, symlinkMarker]) {
    assert.equal(fs.existsSync(profileDir), true, path.basename(profileDir));
    assert.equal(fs.readFileSync(path.join(profileDir, 'keep.txt'), 'utf8'), 'must survive startup cleanup');
  }
  assert.match(failureFor(result, markerless), /missing .*ownership marker/);
  assert.match(failureFor(result, malformedJson), /could not parse .*ownership marker/);
  assert.match(failureFor(result, malformedFields), /invalid ownerPid/);
  assert.match(failureFor(result, nonRegularMarker), /not a regular file/);
  assert.match(failureFor(result, symlinkMarker), /ownership marker is a symbolic link/);
});

test('startup cleanup considers only exact direct children of the selected temp root', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-marker-depth-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const directStale = createManagedBrowserProfile('chrome', tempRoot);
  makeOwnerStale(directStale);

  const markerlessParent = createLookalike(tempRoot, 'http-freekit-edge-backup-tree');
  const nestedOwned = createManagedBrowserProfile('firefox', markerlessParent);
  makeOwnerStale(nestedOwned);

  const result = cleanupStaleBrowserProfiles({ tempDir: tempRoot, processSnapshot: [] });

  assert.deepEqual(result.removed, [directStale]);
  assert.equal(fs.existsSync(directStale), false);
  assert.equal(fs.existsSync(markerlessParent), true);
  assert.equal(fs.existsSync(nestedOwned), true);
  assert.match(failureFor(result, markerlessParent), /missing .*ownership marker/);
  assert.equal(result.failed.some(item => item.path === nestedOwned), false);
});

test('valid ownership markers still preserve active owners and browser processes', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-marker-active-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const activeOwner = createManagedBrowserProfile('chrome', tempRoot);
  const activeOwnerMarker = readMarker(activeOwner);

  const activeBrowser = createManagedBrowserProfile('brave', tempRoot);
  makeOwnerStale(activeBrowser);

  const staleOwned = createManagedBrowserProfile('edge', tempRoot);
  makeOwnerStale(staleOwned);

  const result = cleanupStaleBrowserProfiles({
    tempDir: tempRoot,
    processSnapshot: [{
      pid: activeOwnerMarker.ownerPid,
      ppid: 1,
      startedAt: Date.parse(activeOwnerMarker.ownerStartedAt),
      command: process.execPath
    }, {
      pid: 4242,
      ppid: 1,
      startedAt: Date.now(),
      command: `brave --user-data-dir=${activeBrowser}`
    }]
  });

  assert.deepEqual(result.removed, [staleOwned]);
  assert.deepEqual(result.skippedActive.map(item => path.basename(item)).sort(), [
    path.basename(activeBrowser),
    path.basename(activeOwner)
  ].sort());
  assert.equal(result.failed.length, 0);
  assert.equal(fs.existsSync(activeOwner), true);
  assert.equal(fs.existsSync(activeBrowser), true);
  assert.equal(fs.existsSync(staleOwned), false);
});

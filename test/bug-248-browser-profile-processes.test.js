import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectRelatedProcessIds,
  commandUsesBrowserProfile,
  getRelatedProcessIds,
  inspectRelatedBrowserProcesses
} from '../src/interceptors/browser-lifecycle.js';

function sortedProcessIds(processes, profileDir, rootPids = [], platform = 'linux') {
  return [...collectRelatedProcessIds(processes, profileDir, rootPids, platform)]
    .sort((left, right) => left - right);
}

test('process snapshots associate exact quoted Chromium and Firefox profile arguments', () => {
  const profileDir = '/tmp/HTTP FreeKit/http-freekit-chrome-live';
  const processes = [
    {
      pid: 101,
      ppid: 1,
      command: `chromium --user-data-dir="${profileDir}" --no-first-run`
    },
    { pid: 102, ppid: 101, command: 'chromium --type=renderer' },
    {
      pid: 201,
      ppid: 1,
      command: `firefox -profile '${profileDir}' -no-remote`
    },
    { pid: 202, ppid: 201, command: 'firefox -contentproc' }
  ];

  assert.deepEqual(sortedProcessIds(processes, profileDir), [101, 102, 201, 202]);
});

test('process snapshots reject profile suffixes, prefixes, and incidental diagnostic text', () => {
  const profileDir = '/tmp/http freekit/http-freekit-chrome-live';
  const processes = [
    {
      pid: 301,
      ppid: 1,
      command: `chromium "--user-data-dir=${profileDir}-backup"`
    },
    { pid: 302, ppid: 301, command: 'backup child' },
    {
      pid: 401,
      ppid: 1,
      command: `firefox -profile "${profileDir.slice(0, -5)}"`
    },
    { pid: 402, ppid: 401, command: 'prefix child' },
    {
      pid: 501,
      ppid: 1,
      command: `profile-indexer --message="checking ${profileDir}"`
    },
    {
      pid: 502,
      ppid: 1,
      command: `logger "chromium --user-data-dir=${profileDir}"`
    },
    {
      pid: 503,
      ppid: 1,
      command: `diagnostic --user-data-dir-backup="${profileDir}"`
    },
    {
      pid: 504,
      ppid: 1,
      command: `diagnostic -profile-report "${profileDir}"`
    },
    {
      pid: 505,
      ppid: 1,
      command: `diagnostic --user-data-dir="${profileDir}"`
    },
    {
      pid: 506,
      ppid: 1,
      command: `diagnostic -profile "${profileDir}"`
    }
  ];

  assert.deepEqual(sortedProcessIds(processes, profileDir), []);
});

test('Windows profile arguments are case-insensitive but remain exact', () => {
  const profileDir = 'C:\\Users\\Alice Smith\\Temp\\http-freekit-chrome-live';
  const differentlyCasedProfile = 'c:\\users\\ALICE SMITH\\temp\\HTTP-FREEKIT-CHROME-LIVE';
  const processes = [
    {
      pid: 601,
      ppid: 1,
      command: `"C:\\Program Files\\Google\\Chrome\\chrome.exe" "--user-data-dir=${differentlyCasedProfile}"`
    },
    {
      pid: 602,
      ppid: 1,
      command: `"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -profile "${differentlyCasedProfile}"`
    },
    {
      pid: 603,
      ppid: 1,
      command: `chrome.exe "--user-data-dir=${differentlyCasedProfile}-backup"`
    }
  ];

  assert.deepEqual(sortedProcessIds(processes, profileDir, [], 'win32'), [601, 602]);
  assert.deepEqual(sortedProcessIds(processes, profileDir, [], 'linux'), []);
  assert.equal(commandUsesBrowserProfile(processes[0].command, profileDir, 'win32'), true);
  assert.equal(commandUsesBrowserProfile(processes[0].command, profileDir, 'linux'), false);
});

test('explicit browser roots and complete descendant trees do not depend on profile text', () => {
  const profileDir = '/tmp/http-freekit-chrome-root';
  const rootPid = 701;
  const processes = [
    { pid: rootPid, ppid: 1, command: `diagnostic --user-data-dir="${profileDir}"` },
    { pid: 702, ppid: rootPid, command: 'browser child without a profile argument' },
    { pid: 703, ppid: 702, command: 'browser grandchild without a profile argument' },
    { pid: 704, ppid: 1, command: 'unrelated process' }
  ];

  assert.deepEqual(sortedProcessIds(processes, profileDir, [rootPid]), [701, 702, 703]);
});

test('macOS flattened arguments reject an existing longer profile interpretation', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-argv-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const profileDir = path.join(tempRoot, 'managed');
  fs.mkdirSync(profileDir);
  fs.mkdirSync(`${profileDir} --suffix`);
  fs.mkdirSync(`${profileDir} -suffix`);

  const processes = [
    {
      pid: 801,
      ppid: 1,
      commandName: 'Google Chrome',
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ` +
        `--user-data-dir=${profileDir} --suffix`
    },
    {
      pid: 802,
      ppid: 1,
      commandName: 'firefox',
      command: `/Applications/Firefox.app/Contents/MacOS/firefox -profile ${profileDir} -suffix`
    },
    {
      pid: 803,
      ppid: 1,
      commandName: 'Google Chrome',
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ` +
        `--user-data-dir=${profileDir} --no-first-run ` +
        `--user-data-dir=${profileDir} --suffix`
    }
  ];

  assert.deepEqual(sortedProcessIds(processes, profileDir, [], 'darwin'), []);
  const inspection = inspectRelatedBrowserProcesses(processes, profileDir, [], 'darwin');
  assert.deepEqual([...inspection.processIds], []);
  assert.deepEqual([...inspection.ambiguousProcessIds], [801, 802, 803]);
  assert.throws(
    () => getRelatedProcessIds(profileDir, [], processes, 'darwin'),
    error => error?.code === 'AMBIGUOUS_BROWSER_PROFILE_PROCESS'
  );
  assert.equal(commandUsesBrowserProfile(
    processes[0].command,
    profileDir,
    'darwin',
    processes[0].commandName
  ), false);
  assert.equal(commandUsesBrowserProfile(
    processes[1].command,
    profileDir,
    'darwin',
    processes[1].commandName
  ), false);
});

test('ambiguous browser descendants never enter the exact process closure', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-descendant-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const profileDir = path.join(tempRoot, 'managed');
  fs.mkdirSync(profileDir);
  fs.mkdirSync(`${profileDir} --suffix`);
  const processes = [
    {
      pid: 810,
      ppid: 1,
      commandName: 'Google Chrome',
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ` +
        `--user-data-dir=${profileDir} --no-first-run`
    },
    {
      pid: 811,
      ppid: 810,
      commandName: 'Google Chrome',
      command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ` +
        `--user-data-dir=${profileDir} --suffix`
    },
    { pid: 812, ppid: 811, command: 'chrome helper' }
  ];

  const inspection = inspectRelatedBrowserProcesses(processes, profileDir, [], 'darwin');
  assert.deepEqual([...inspection.processIds], [810]);
  assert.deepEqual([...inspection.ambiguousProcessIds], [811]);
});

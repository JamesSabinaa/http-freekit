import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRelatedProcessIds,
  parsePosixProcessSnapshot,
  parseWindowsProcessSnapshot
} from '../src/interceptors/browser-lifecycle.js';
import { ExistingBrowserInterceptor } from '../src/interceptors/existing-browser-interceptor.js';

const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function detector(platform, processSnapshot) {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._getPlatform = () => platform;
  interceptor._getProcessSnapshot = async () => processSnapshot;
  return interceptor;
}

test('incidental selected-browser text in later process arguments is never a match', async () => {
  const windows = detector('win32', [{
    executablePath: 'C:\\Windows\\System32\\notepad.exe',
    command: `notepad.exe "${WINDOWS_CHROME}"`,
    argv0: 'notepad.exe'
  }]);
  assert.equal(await windows._isBrowserRunning(WINDOWS_CHROME), false);

  const fallbackOnly = detector('win32', [{
    command: `notepad.exe "${WINDOWS_CHROME}" --diagnose`,
    executablePath: null
  }]);
  assert.equal(await fallbackOnly._isBrowserRunning(WINDOWS_CHROME), false);

  const posix = detector('linux', [{
    commandName: 'cat',
    command: `cat /usr/bin/google-chrome`,
    executablePath: null
  }]);
  assert.equal(await posix._isBrowserRunning('/usr/bin/google-chrome'), false);
});

test('Windows detection normalizes full paths, separators, spaces, and case', async () => {
  const exactPath = detector('win32', [{
    executablePath: 'c:/PROGRAM FILES/google/chrome/application/CHROME.EXE',
    command: ''
  }]);
  assert.equal(await exactPath._isBrowserRunning(WINDOWS_CHROME), true);

  const quotedArgv0 = detector('win32', [{
    executablePath: null,
    command: `"c:\\program files\\GOOGLE\\chrome\\application\\CHROME.exe" --type=browser`
  }]);
  assert.equal(await quotedArgv0._isBrowserRunning(WINDOWS_CHROME), true);

  const authoritativeMismatch = detector('win32', [{
    executablePath: 'D:\\Portable\\Chrome\\chrome.exe',
    command: `"${WINDOWS_CHROME}" --type=browser`
  }]);
  assert.equal(await authoritativeMismatch._isBrowserRunning(WINDOWS_CHROME), false);
});

test('basename and argv0 fallbacks recognize legitimate executable names', async () => {
  const windows = detector('win32', [{
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\CHROME.EXE',
    command: ''
  }]);
  assert.equal(await windows._isBrowserRunning('chrome.exe'), true);

  const windowsArgv0 = detector('win32', [{
    executablePath: null,
    command: 'CHROME.EXE --type=browser'
  }]);
  assert.equal(await windowsArgv0._isBrowserRunning(WINDOWS_CHROME), true);

  const linux = detector('linux', [{
    executablePath: null,
    commandName: 'google-chrome',
    command: 'google-chrome --type=browser'
  }]);
  assert.equal(await linux._isBrowserRunning('google-chrome'), true);
});

test('POSIX detection accepts authoritative comm names and quoted argv0 paths with spaces', async () => {
  const commandName = detector('darwin', [{
    executablePath: null,
    commandName: 'Google Chrome',
    command: `${MAC_CHROME} --type=browser`
  }]);
  assert.equal(await commandName._isBrowserRunning(MAC_CHROME), true);

  const quotedArgv0 = detector('darwin', [{
    executablePath: null,
    commandName: null,
    command: `"${MAC_CHROME}" --type=browser`
  }]);
  assert.equal(await quotedArgv0._isBrowserRunning(MAC_CHROME), true);

  const wrongCase = detector('darwin', [{
    executablePath: null,
    commandName: 'google chrome',
    command: 'google chrome --type=browser'
  }]);
  assert.equal(await wrongCase._isBrowserRunning(MAC_CHROME), false);
});

test('Windows snapshots expose sanitized executable paths and argv0 separately from arguments', () => {
  const rows = parseWindowsProcessSnapshot(JSON.stringify([{
    pid: 101,
    ppid: 1,
    startedAt: '2026-07-26T10:20:30.000Z',
    executablePath: `  ${WINDOWS_CHROME}  `,
    command: `"${WINDOWS_CHROME}" --type=browser`
  }, {
    pid: 102,
    ppid: 1,
    startedAt: null,
    executablePath: 'bad\npath.exe',
    command: `notepad.exe "${WINDOWS_CHROME}"`
  }]));

  assert.equal(rows[0].executablePath, WINDOWS_CHROME);
  assert.equal(rows[0].argv0, WINDOWS_CHROME);
  assert.equal(rows[0].command, `"${WINDOWS_CHROME}" --type=browser`);
  assert.equal(rows[0].commandName, null);
  assert.equal(rows[1].executablePath, null);
  assert.equal(rows[1].argv0, 'notepad.exe');
});

test('POSIX snapshots use macOS comm when application paths are unquoted', () => {
  const profileDir = '/tmp/HTTP FreeKit/http-freekit-chrome-live';
  const processOutput = [
    ` 201 Google Chrome 201 1 Sun Jul 26 10:20:30 2026 ${MAC_CHROME} --user-data-dir=${profileDir}`,
    ' 202 Google Chrome Helper (Renderer) 202 201 Sun Jul 26 10:20:31 2026 chrome --type=renderer'
  ].join('\n');

  const rows = parsePosixProcessSnapshot(processOutput);

  assert.equal(rows[0].commandName, 'Google Chrome');
  assert.equal(rows[0].argv0, '/Applications/Google');
  assert.equal(
    rows[0].command,
    `${MAC_CHROME} --user-data-dir=${profileDir}`
  );
  assert.equal(rows[1].commandName, 'Google Chrome Helper (Renderer)');
  assert.equal(rows[1].argv0, 'chrome');
  assert.deepEqual(
    [...collectRelatedProcessIds(rows, profileDir, [], 'darwin')].sort((a, b) => a - b),
    [201, 202]
  );
});

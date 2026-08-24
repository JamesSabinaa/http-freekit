import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectDarwinProcessIdentity,
  inspectLinuxProcessIdentity,
  inspectProcessIdentity,
  normalizeExecutableIdentity,
  normalizeLinuxBootId,
  normalizeProcessIdentity,
  parseLinuxProcessStart,
  sameProcessIdentity
} from '../../../src/interceptors/process-identity.js';

test('process identities normalize platform paths and optionally retain their platform', () => {
  assert.deepEqual(
    normalizeProcessIdentity({
      pid: 4123,
      startTime: '987654',
      executable: 'C:\\Program Files\\FreeKit\\..\\FreeKit\\APP.EXE'
    }, 4123, { platform: 'win32', includePlatform: true }),
    {
      pid: 4123,
      startTime: '987654',
      executable: 'c:\\program files\\freekit\\app.exe',
      platform: 'win32'
    }
  );
  assert.equal(
    normalizeExecutableIdentity('/opt/freekit/../freekit/app', {
      platform: 'auto',
      requireAbsolute: true
    }),
    '/opt/freekit/app'
  );
  assert.throws(
    () => normalizeExecutableIdentity('../relative-app', { requireAbsolute: true }),
    /not absolute/
  );
});

test('process identity validation rejects unstable or unexpected identifiers', () => {
  assert.throws(
    () => normalizeProcessIdentity({
      pid: 4124,
      startTime: 'not-stable',
      executable: '/opt/freekit/app'
    }, 4124, { platform: 'linux' }),
    /start identity/
  );
  assert.throws(
    () => normalizeProcessIdentity({
      pid: 4125,
      startTime: '123',
      executable: '/opt/freekit/app'
    }, 4126, { platform: 'linux' }),
    /PID/
  );
});

test('Linux process parsing ignores parentheses inside the command name', () => {
  const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '7654321'];
  assert.equal(
    parseLinuxProcessStart(`5123 (shell (login)) ${fields.join(' ')}`, 5123),
    '7654321'
  );
});

test('Linux inspection scopes process start ticks to a stable kernel boot ID', async () => {
  const pid = 5124;
  const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '7654322'];
  const stat = `${pid} (login shell) ${fields.join(' ')}`;
  const bootId = '11111111-1111-4111-8111-111111111111';
  const identity = await inspectLinuxProcessIdentity(pid, {
    includeBootId: true,
    readFile: async filePath => filePath.endsWith('boot_id') ? `${bootId}\n` : stat,
    readlink: async () => '/usr/bin/bash'
  });

  assert.deepEqual(identity, {
    pid,
    startTime: '7654322',
    executable: '/usr/bin/bash',
    bootId
  });
  assert.equal(normalizeLinuxBootId(bootId.toUpperCase()), bootId);
});

test('macOS inspection accepts both shared exec result shapes', async () => {
  const output = '6123 Sun Jul 26 12:34:56 2026 /Applications/FreeKit.app/Contents/MacOS/FreeKit\n';
  for (const result of [output, { stdout: output }]) {
    const identity = await inspectDarwinProcessIdentity(6123, {
      execFile: async () => result,
      timeoutMs: 321,
      environment: { PATH: '/usr/bin' }
    });
    assert.deepEqual(identity, {
      pid: 6123,
      startTime: String(Date.parse('Sun Jul 26 12:34:56 2026')),
      executable: '/Applications/FreeKit.app/Contents/MacOS/FreeKit'
    });
  }
});

test('macOS inspection scopes process identity to the boot session UUID', async () => {
  const bootId = '22222222-2222-4222-8222-222222222222';
  let bootReads = 0;
  const identity = await inspectDarwinProcessIdentity(6124, {
    includeBootId: true,
    getBootId: async () => {
      bootReads++;
      return bootId.toUpperCase();
    },
    execFile: async () => ({
      stdout: '6124 Sun Jul 26 12:34:57 2026 /bin/sh\n'
    }),
    timeoutMs: 321,
    environment: { PATH: '/usr/bin' }
  });

  assert.deepEqual(identity, {
    pid: 6124,
    startTime: String(Date.parse('Sun Jul 26 12:34:57 2026')),
    executable: '/bin/sh',
    bootId
  });
  assert.equal(bootReads, 2);
});

test('identity inspection preserves absent and ambiguous process states', async () => {
  const absent = await inspectProcessIdentity(7123, {
    platform: 'darwin',
    execFile: async () => { throw new Error('process disappeared'); },
    probePid: () => 'absent'
  });
  assert.deepEqual(absent, { state: 'absent' });

  const ambiguous = await inspectProcessIdentity(7124, {
    platform: 'darwin',
    execFile: async () => { throw new Error('metadata unavailable'); },
    probePid: () => 'running'
  });
  assert.equal(ambiguous.state, 'unknown');
  assert.match(ambiguous.error.message, /metadata unavailable/);
});

test('process identity comparison can include or ignore platform', () => {
  const linux = { pid: 8123, startTime: '123', executable: '/opt/app', platform: 'linux' };
  const darwin = { ...linux, platform: 'darwin' };
  assert.equal(sameProcessIdentity(linux, darwin), true);
  assert.equal(sameProcessIdentity(linux, darwin, { includePlatform: true }), false);
});

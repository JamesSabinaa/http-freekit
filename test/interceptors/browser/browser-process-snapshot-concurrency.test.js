import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { getProcessSnapshotAsync } from '../../../src/interceptors/browser-lifecycle.js';

test('concurrent browser inspections share one OS query and refresh after success or failure', async t => {
  const commands = [];
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    commands.push({ file, args, options, callback });
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const output = process.platform === 'win32'
    ? '[{"pid":101,"ppid":1,"command":"chrome.exe","startedAt":"2026-11-12T08:00:00Z"}]'
    : '101 chrome 101 1 Thu Nov 12 08:00:00 2026 chrome';

  const first = getProcessSnapshotAsync();
  const second = getProcessSnapshotAsync();
  assert.equal(commands.length, 1);
  commands[0].callback(null, output);
  for (const snapshot of await Promise.all([first, second])) {
    assert.equal(snapshot[0].pid, 101);
  }
  const failed = [getProcessSnapshotAsync(), getProcessSnapshotAsync()];
  assert.equal(commands.length, 2);
  const error = Object.assign(new Error('inspection timed out'), { code: 'ETIMEDOUT' });
  const outcomes = Promise.allSettled(failed);
  commands[1].callback(error);
  assert.ok((await outcomes).every(result => result.status === 'rejected'));

  const recovered = getProcessSnapshotAsync();
  assert.equal(commands.length, 3);
  commands[2].callback(null, output);
  assert.equal((await recovered)[0].pid, 101);
});

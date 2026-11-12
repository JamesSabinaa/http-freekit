import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
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
  const error = Object.assign(new Error('inspection denied'), { code: 'EACCES' });
  const outcomes = Promise.allSettled(failed);
  commands[1].callback(error);
  assert.ok((await outcomes).every(result => result.status === 'rejected'));

  const recovered = getProcessSnapshotAsync();
  assert.equal(commands.length, 3);
  commands[2].callback(null, output);
  assert.equal((await recovered)[0].pid, 101);
});

test('Windows inspections retry one timeout and expose concise failures after the retry', { skip: process.platform !== 'win32' }, async t => {
  const commands = [];
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    commands.push({ file, args, options, callback });
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const timeout = () => Object.assign(new Error('Command failed: powershell.exe private command text'), { killed: true, signal: 'SIGTERM', code: null });
  const first = getProcessSnapshotAsync();
  const concurrent = getProcessSnapshotAsync();
  commands[0].callback(timeout());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.length, 2);
  commands[1].callback(null, '[{"pid":101,"ppid":1}]');
  assert.equal((await first)[0].pid, 101);
  assert.equal((await concurrent)[0].pid, 101);

  const failed = getProcessSnapshotAsync();
  const rejection = assert.rejects(failed, error => error.code === 'ETIMEDOUT'
    && error.message === 'Windows process query timed out after two attempts'
    && !error.message.includes('private command text'));
  commands[2].callback(timeout());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.length, 4);
  commands[3].callback(timeout());
  await rejection;
});

test('real Windows snapshots preserve non-ASCII process arguments', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const marker = `freekit-snapshot-\u4e2d\u6587-${process.pid}`;
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', marker], { windowsHide: true, stdio: 'ignore' });
  t.after(() => child.kill());
  await once(child, 'spawn');
  const snapshot = await getProcessSnapshotAsync();
  const row = snapshot.find(item => item.pid === child.pid);
  assert.ok(row, 'the controlled child must be present in the OS snapshot');
  assert.ok(row.command.includes(marker), 'CIM must preserve the exact Unicode argument');
});

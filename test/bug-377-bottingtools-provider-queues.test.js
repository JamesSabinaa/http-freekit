import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function apiMethods() {
  return Object.create(ApiServer.prototype);
}

test('BottingTools keeps a separate working proxy queue for every provider', async t => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-provider-queues-'));
  t.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));

  const api = apiMethods();
  api.bottingToolsWorkDir = workRoot;
  const calls = [];
  api._runPythonJson = async (script, args, options) => {
    calls.push({ script, args, options });
    return { provider: args[0] };
  };

  await api._getBottingToolsProxy('vital.txt', true);
  await api._getBottingToolsProxy('lemonprime.txt', true);
  await api._getBottingToolsProxy('lemonprime.txt', false);

  assert.deepEqual(calls.map(call => call.args), [
    ['vital.txt', 'true'],
    ['lemonprime.txt', 'true'],
    ['lemonprime.txt', 'false']
  ]);
  assert.notEqual(calls[0].options.cwd, calls[1].options.cwd);
  assert.equal(calls[1].options.cwd, calls[2].options.cwd);
  assert.equal(path.dirname(calls[0].options.cwd), workRoot);
  assert.equal(path.dirname(calls[1].options.cwd), workRoot);
  assert.equal(fs.statSync(calls[0].options.cwd).isDirectory(), true);
  assert.equal(fs.statSync(calls[1].options.cwd).isDirectory(), true);
});

test('BottingTools passes the provider queue directory to every Python candidate', async () => {
  const api = apiMethods();
  const candidates = [
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] }
  ];
  const attempts = [];
  api._getBottingToolsPythonCandidates = () => candidates;
  api._execBottingToolsPythonJson = async (candidate, script, args, options) => {
    attempts.push({ candidate, script, args, options });
    if (candidate.command === 'py') throw new Error('launcher missing');
    return { provider: args[0] };
  };

  const options = { cwd: path.join(os.tmpdir(), 'provider-queue') };
  const result = await api._runPythonJson('print-json', ['lemonprime.txt'], options);

  assert.deepEqual(result, { provider: 'lemonprime.txt' });
  assert.deepEqual(attempts.map(attempt => attempt.candidate), candidates);
  assert.ok(attempts.every(attempt => attempt.options === options));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function apiMethods() {
  return Object.create(ApiServer.prototype);
}

test('Python candidates are platform-aware and keep integration overrides separate', () => {
  const api = apiMethods();
  assert.deepEqual(api._getPythonCandidates(null, 'win32'), [
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] }
  ]);
  assert.deepEqual(api._getPythonCandidates(null, 'linux'), [
    { command: 'python3', args: [] },
    { command: 'python', args: [] }
  ]);
  assert.deepEqual(api._getPythonCandidates('C:\\Python312\\python.exe', 'win32'), [
    { command: 'C:\\Python312\\python.exe', args: [] }
  ]);

  const previousBottingTools = process.env.BOTTINGTOOLS_PYTHON;
  const previousGenerator = process.env.GENERATOR_PYTHON;
  try {
    process.env.BOTTINGTOOLS_PYTHON = 'botting-python';
    process.env.GENERATOR_PYTHON = 'generator-python';
    assert.deepEqual(api._getBottingToolsPythonCandidates(), [
      { command: 'botting-python', args: [] }
    ]);
    assert.deepEqual(api._getGeneratorPythonCandidates(), [
      { command: 'generator-python', args: [] }
    ]);
  } finally {
    if (previousBottingTools === undefined) delete process.env.BOTTINGTOOLS_PYTHON;
    else process.env.BOTTINGTOOLS_PYTHON = previousBottingTools;
    if (previousGenerator === undefined) delete process.env.GENERATOR_PYTHON;
    else process.env.GENERATOR_PYTHON = previousGenerator;
  }
});

test('BottingTools tries later Python candidates when earlier interpreters fail', async () => {
  const api = apiMethods();
  const candidates = [
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] }
  ];
  const attempts = [];
  api._getBottingToolsPythonCandidates = () => candidates;
  api._execBottingToolsPythonJson = async (candidate, script, args) => {
    attempts.push({ candidate, script, args });
    if (candidate.command === 'py') throw new Error('launcher missing');
    if (candidate.command === 'python') throw new Error('module missing');
    return { providers: ['working'] };
  };

  const result = await api._runPythonJson('print-json', ['provider']);

  assert.deepEqual(result, { providers: ['working'] });
  assert.deepEqual(attempts.map(attempt => attempt.candidate), candidates);
  assert.ok(attempts.every(attempt => attempt.script === 'print-json'));
  assert.ok(attempts.every(attempt => attempt.args[0] === 'provider'));
});

test('BottingTools reports every attempted Python command when none work', async () => {
  const api = apiMethods();
  api._getBottingToolsPythonCandidates = () => [
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] }
  ];
  api._execBottingToolsPythonJson = async candidate => {
    throw new Error(`${candidate.command} failed`);
  };

  await assert.rejects(
    api._runPythonJson('print-json'),
    error => {
      assert.match(error.message, /^Could not run BottingTools Python\./);
      assert.match(error.message, /py -3: py failed/);
      assert.match(error.message, /python: python failed/);
      return true;
    }
  );
});
